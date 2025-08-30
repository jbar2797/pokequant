// src/index.ts
// PokeQuant Worker — monolith (in-progress modularization). Factor & utility logic moved to ./lib/*.

import { compositeScore } from './signal_math';
import { sendEmail, EMAIL_RETRY_MAX } from './email_adapter';
import { APP_VERSION } from './version';
import { z } from 'zod';
import { runMigrations, listMigrations } from './migrations';
// Modularized helpers
import { Env } from './lib/types';
import { log } from './lib/log';
import { json, err, CORS } from './lib/http';
import { isoDaysAgo } from './lib/date';
import { sha256Hex } from './lib/crypto';
import { rateLimit, getRateLimits } from './lib/rate_limit';
import { incMetric, incMetricBy, recordLatency } from './lib/metrics';
import { audit } from './lib/audit';
import { portfolioAuth } from './lib/portfolio_auth';
import { getFactorUniverse, computeFactorReturns, computeFactorRiskModel, smoothFactorReturns, computeSignalQuality, computeFactorIC } from './lib/factors';
import { computeIntegritySnapshot, updateDataCompleteness } from './lib/integrity';
import { purgeOldData } from './lib/retention';
import { snapshotPortfolioNAV, computePortfolioPnL } from './lib/portfolio_nav';
import { ensureTestSeed, ensureAlertsTable, getAlertThresholdCol } from './lib/data';
import { runIncrementalIngestion } from './lib/ingestion';
import { baseDataSignature } from './lib/base_data';



// ---------- performance indices (lazy, one-time per isolate) ----------
let INDICES_DONE = false;
async function ensureIndices(env: Env) {
  if (INDICES_DONE) return;
  try {
    const tablesRes = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const names = new Set((tablesRes.results||[]).map((r:any)=> String(r.name)));
    const stmts: D1PreparedStatement[] = [];
    if (names.has('prices_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_prices_card_asof ON prices_daily(card_id, as_of);`));
    if (names.has('signals_daily')) {
      stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_card_asof ON signals_daily(card_id, as_of);`));
      stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_asof ON signals_daily(as_of);`));
    }
    if (names.has('svi_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_svi_card_asof ON svi_daily(card_id, as_of);`));
    if (names.has('signal_components_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_components_card_asof ON signal_components_daily(card_id, as_of);`));
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) {
    log('ensure_indices_error', { error: String(e) });
  } finally {
    INDICES_DONE = true; // avoid repeated attempts even if some failed
  }
}

// ---------- rate limiting (D1-backed fixed window) ----------
// rate limiting now in lib/rate_limit

// ---------- metrics (simple daily counter in D1) ----------
// metrics helpers now in lib/metrics

// ---------- mutation audit helper ----------
// Lightweight audit trail for state-changing endpoints. Best-effort (errors ignored).
// audit helper now in lib/audit


// ---------- universe fetch (unchanged) ----------
async function fetchUniverse(env: Env) {
  const rarities = [
    'Special illustration rare','Illustration rare','Ultra Rare',
    'Rare Secret','Rare Rainbow','Full Art','Promo'
  ];
  const q = encodeURIComponent(rarities.map(r => `rarity:"${r}"`).join(' OR ') + ' -set.series:"Japanese"');
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.PTCG_API_KEY }});
  if (!res.ok) throw new Error(`PTCG ${res.status}`);
  const j: any = await res.json().catch(()=>({}));
  return j && Array.isArray(j.data) ? j.data : [];
}

async function upsertCards(env: Env, cards: any[]) {
  if (!cards?.length) return;
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    batch.push(env.DB.prepare(`
      INSERT OR REPLACE INTO cards
      (id, name, set_id, set_name, number, rarity, image_url, tcgplayer_url, cardmarket_url, types)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT types FROM cards WHERE id=?)))
    `).bind(
      c.id, c.name, c.set?.id ?? null, c.set?.name ?? null, c.number ?? null,
      c.rarity ?? null, c.images?.small ?? null, c.tcgplayer?.url ?? null, c.cardmarket?.url ?? null,
      Array.isArray(c.types) ? c.types.join('|') : null, c.id
    ));
  }
  await env.DB.batch(batch);
}

async function snapshotPrices(env: Env, cards: any[]) {
  const today = new Date().toISOString().slice(0,10);
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const tp = c.tcgplayer, cm = c.cardmarket;
    const usd = tp?.prices ? (() => { const any = Object.values(tp.prices)[0] as any; return (any?.market ?? any?.mid ?? null); })() : null;
    const eur = cm?.prices?.trendPrice ?? cm?.prices?.avg7 ?? cm?.prices?.avg30 ?? null;
    batch.push(env.DB.prepare(`
      INSERT OR REPLACE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(c.id, today, usd, eur, tp?.updatedAt || cm?.updatedAt || null));
  }
  await env.DB.batch(batch);
}

// ---------- BULK signals (safe) ----------
async function computeSignalsBulk(env: Env, daysLookback = 365) {
  const today = new Date().toISOString().slice(0,10);
  const since = isoDaysAgo(daysLookback);

  // 1) IDs once
  const idRes = await env.DB.prepare(`SELECT id FROM cards`).all();
  const ids: string[] = (idRes.results ?? []).map((r:any)=> r.id);

  // 2) Bulk series reads (2 queries total)
  const [pricesRes, sviRes] = await Promise.all([
    env.DB.prepare(`
      SELECT card_id, as_of, COALESCE(price_usd, price_eur) AS p
      FROM prices_daily
      WHERE as_of >= ?
      ORDER BY card_id ASC, as_of ASC
    `).bind(since).all(),
    env.DB.prepare(`
      SELECT card_id, as_of, svi
      FROM svi_daily
      WHERE as_of >= ?
      ORDER BY card_id ASC, as_of ASC
    `).bind(since).all()
  ]);

  // 3) Build in-memory maps
  const priceMap = new Map<string, number[]>();
  for (const r of (pricesRes.results ?? []) as any[]) {
    const arr = priceMap.get(r.card_id) ?? [];
    if (typeof r.p === 'number') arr.push(r.p);
    priceMap.set(r.card_id, arr);
  }
  const sviMap = new Map<string, number[]>();
  for (const r of (sviRes.results ?? []) as any[]) {
    const arr = sviMap.get(r.card_id) ?? [];
    arr.push(Number(r.svi) || 0);
    sviMap.set(r.card_id, arr);
  }

  // 4) Compute & batch writes
  const writesSignals: D1PreparedStatement[] = [];
  const writesComponents: D1PreparedStatement[] = [];

  for (const id of ids) {
    const prices = priceMap.get(id) ?? [];
    const svis   = sviMap.get(id) ?? [];

    if (prices.length < 1 && svis.length < 7) continue;

    const out = compositeScore(prices, svis);
    let { score, signal, reasons, edgeZ, expRet, expSd, components } = out;
    // Dynamic weight override (optional): factor_weights table
    try {
      const wRes = await env.DB.prepare(`SELECT factor, weight FROM factor_weights WHERE active=1 AND version=(SELECT MAX(version) FROM factor_weights WHERE active=1)`).all();
      const rows = (wRes.results||[]) as any[];
      if (rows.length) {
        const m: Record<string, number> = {};
        for (const r of rows) m[String(r.factor)] = Number(r.weight);
        const parts: number[] = []; let totalW = 0;
  // Map known factors: ts7, ts30, z_svi, risk(vol), liquidity, scarcity, mom90
        if (components.ts7 !== null && m.ts7 !== undefined) { parts.push((components.ts7 as number)*m.ts7*100); totalW += Math.abs(m.ts7); }
        if (components.ts30 !== null && m.ts30 !== undefined) { parts.push((components.ts30 as number)*m.ts30*100); totalW += Math.abs(m.ts30); }
        if (components.zSVI !== null && m.z_svi !== undefined) { parts.push((components.zSVI as number)*m.z_svi*10); totalW += Math.abs(m.z_svi); }
        if (components.vol !== null && m.risk !== undefined) { parts.push(-(components.vol as number)*m.risk*10); totalW += Math.abs(m.risk); }
  if ((components as any).liquidity !== undefined && m.liquidity !== undefined) { parts.push(((components as any).liquidity as number)*m.liquidity); totalW += Math.abs(m.liquidity); }
  if ((components as any).scarcity !== undefined && m.scarcity !== undefined) { parts.push(((components as any).scarcity as number)*m.scarcity*50); totalW += Math.abs(m.scarcity); }
  if ((components as any).mom90 !== undefined && m.mom90 !== undefined) { parts.push(((components as any).mom90 as number)*m.mom90*80); totalW += Math.abs(m.mom90); }
        if (parts.length && totalW>0) {
          const base = 50 + parts.reduce((a,b)=>a+b,0);
          score = Math.max(0, Math.min(100, base));
          signal = score >= 66 ? 'BUY' : score <= 33 ? 'SELL' : 'HOLD';
          edgeZ = (score - 50)/15;
          expRet = 0.001 * (score - 50);
          expSd = Math.max(0.01, (components.vol ?? 0.2)/Math.sqrt(252));
          reasons.push('dyn_weights_applied');
        }
      }
    } catch {/* ignore weighting errors */}

    writesSignals.push(env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd));

    // Additional factors: liquidity (inverse vol), scarcity (placeholder rarity-based), mom90 simple momentum
    let liquidity: number|null = null;
    if (components.vol != null && components.vol > 0) liquidity = 1/components.vol;
    let scarcity: number|null = null;
    try {
      const rar = await env.DB.prepare(`SELECT rarity FROM cards WHERE id=?`).bind(id).all();
      const r = (rar.results?.[0] as any)?.rarity || '';
      // Simple heuristic mapping rarity to numeric scarcity score
      const map: Record<string, number> = { 'Common': 0.2,'Uncommon':0.4,'Rare':0.6,'Ultra Rare':0.8,'Secret Rare':0.9 };
      scarcity = map[r] ?? (r ? 0.5 : null);
    } catch {/* ignore */}
    let mom90: number|null = null;
    if (prices.length >= 90 && prices[0] > 0) {
      const first = prices[Math.max(0, prices.length-90)];
      const last = prices[prices.length-1];
      if (first && last) mom90 = (last-first)/first;
    }
    writesComponents.push(env.DB.prepare(`
      INSERT OR REPLACE INTO signal_components_daily
      (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break, liquidity, scarcity, mom90)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, today, components.ts7, components.ts30, components.dd, components.vol, components.zSVI, components.regimeBreak ? 1 : 0, liquidity, scarcity, mom90));
  }

  // 5) Flush in chunks to avoid payload/time limits
  const flush = async (stmts: D1PreparedStatement[], chunk = 100) => {
    for (let i=0; i<stmts.length; i+=chunk) {
      await env.DB.batch(stmts.slice(i, i+chunk));
    }
  };
  await flush(writesSignals);
  await flush(writesComponents);

  return { idsProcessed: ids.length, wroteSignals: writesSignals.length };
}

async function runAlerts(env: Env) {
  await ensureAlertsTable(env);
  const col = await getAlertThresholdCol(env);
  const rs = await env.DB.prepare(`
  SELECT a.id, a.email, a.card_id, a.kind, a.${col} as threshold, 
           (SELECT COALESCE(price_usd, price_eur) FROM prices_daily p WHERE p.card_id=a.card_id ORDER BY as_of DESC LIMIT 1) AS px
    FROM alerts_watch a
  WHERE a.active=1 AND (a.suppressed_until IS NULL OR a.suppressed_until < datetime('now'))
  `).all();
  let fired = 0;
  for (const a of (rs.results ?? []) as any[]) {
    const px = Number(a.px);
    const th = Number(a.threshold);
    if (!Number.isFinite(px) || !Number.isFinite(th)) continue;
    const kind = String(a.kind || 'price_below');
    const hit = (kind === 'price_below') ? (px <= th) : (px >= th);
    if (!hit) continue;
    await env.DB.prepare(`UPDATE alerts_watch SET last_fired_at=datetime('now'), fired_count=COALESCE(fired_count,0)+1 WHERE id=?`).bind(a.id).run();
    // Escalation metric at certain counts
    try {
      const escRow = await env.DB.prepare(`SELECT fired_count FROM alerts_watch WHERE id=?`).bind(a.id).all();
      const fc = Number((escRow.results||[])[0]?.fired_count)||0;
      if (fc===5||fc===10||fc===25) incMetric(env, 'alert.escalation');
    } catch {/* ignore */}
    // Queue mock email
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_email_queue (id TEXT PRIMARY KEY, created_at TEXT, email TEXT, card_id TEXT, kind TEXT, threshold_usd REAL, status TEXT, sent_at TEXT);`).run();
      const qid = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO alert_email_queue (id, created_at, email, card_id, kind, threshold_usd, status) VALUES (?,?,?,?,?,?,?)`).bind(qid, new Date().toISOString(), a.email, a.card_id, kind, th, 'queued').run();
  // Metric for queued alert notifications
  incMetric(env, 'alert.queued'); // fire & forget
    } catch {/* ignore queue errors */}
    fired++;
  }
  return { checked: (rs.results ?? []).length, fired };
}


// ---------- Admin: fetch+upsert+compute (may hit limits if upstream is slow) ----------
async function pipelineRun(env: Env) {
  const t0 = Date.now();
  let universe: any[] = [];
  try { universe = await fetchUniverse(env); } catch (_e) {}
  if (universe.length) {
    await upsertCards(env, universe);
    await snapshotPrices(env, universe);
  }
  const t1 = Date.now();
  const bulk = await computeSignalsBulk(env, 365);
  const t2 = Date.now();
  const alerts = await runAlerts(env);
  const t3 = Date.now();
  await updateDataCompleteness(env); // record today's counts

  const today = new Date().toISOString().slice(0,10);
  const [prices, signals] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`).bind(today).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`).bind(today).all(),
  ]);

  return {
    ok: true,
    pricesForToday: prices.results?.[0]?.n ?? 0,
    signalsForToday: signals.results?.[0]?.n ?? 0,
    bulk,
    alerts,
    timingsMs: { fetchUpsert: t1-t0, bulkCompute: t2-t1, alerts: t3-t2, total: t3-t0 }
  };
}


// ----- Anomaly detection (large price move >25% day over day) -----
async function detectAnomalies(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS anomalies (id TEXT PRIMARY KEY, as_of DATE, card_id TEXT, kind TEXT, magnitude REAL, created_at TEXT);`).run();
    const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest))
      SELECT c.id AS card_id,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id AND p.as_of=(SELECT d FROM latest)) AS px_l,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id AND p.as_of=(SELECT d FROM prev)) AS px_p
      FROM cards c`).all();
    const today = new Date().toISOString().slice(0,10);
    for (const r of (rs.results||[]) as any[]) {
      const a = Number(r.px_p)||0, b=Number(r.px_l)||0; if (!a||!b) continue;
      const ch = (b - a)/a;
      if (Math.abs(ch) >= 0.25) {
        const id = crypto.randomUUID();
        await env.DB.prepare(`INSERT OR REPLACE INTO anomalies (id, as_of, card_id, kind, magnitude, created_at) VALUES (?,?,?,?,?,datetime('now'))`).bind(id, today, r.card_id, ch>0? 'price_spike':'price_crash', ch,).run();
      }
    }
  } catch (e) { log('anomaly_error', { error:String(e) }); }
}


// Factor returns: compute top-bottom quintile forward return per enabled factor (using previous day factor values and forward price move)
// factor returns now in lib/factors

// ----- Factor risk model (covariance & correlation) + rolling vol/beta -----
// risk model now in lib/factors

// ----- Bayesian smoothing of factor returns (simple shrink to grand mean) -----
// smoothing now in lib/factors

// ----- Signal quality metrics (IC stability & half-life) -----
// signal quality now in lib/factors


// Snapshot portfolio factor exposures into history table
async function snapshotPortfolioFactorExposure(env: Env) {
  try {
    const latest = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all();
    const d = (latest.results?.[0] as any)?.d; if (!d) return;
    const ports = await env.DB.prepare(`SELECT id FROM portfolios`).all();
    for (const p of (ports.results||[]) as any[]) {
      const rs = await env.DB.prepare(`SELECT l.card_id,l.qty, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90 FROM lots l LEFT JOIN signal_components_daily sc ON sc.card_id=l.card_id AND sc.as_of=? WHERE l.portfolio_id=?`).bind(d, p.id).all();
      const rows = (rs.results||[]) as any[]; if (!rows.length) continue;
      const factors = ['ts7','ts30','z_svi','vol','liquidity','scarcity','mom90'];
      const agg: Record<string,{w:number; sum:number}> = {};
      for (const r of rows) { const q=Number(r.qty)||0; if (q<=0) continue; for (const f of factors) { const val = Number(r[f]); if (!Number.isFinite(val)) continue; const slot = agg[f]||(agg[f]={w:0,sum:0}); slot.w+=q; slot.sum+=val*q; } }
      for (const f of factors) {
        const a=agg[f]; if (!a||a.w<=0) continue;
        const exposure = a.sum/a.w;
        await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_factor_exposure (portfolio_id, as_of, factor, exposure) VALUES (?,?,?,?)`).bind(p.id, d, f, exposure).run();
      }
    }
  } catch (e) { log('portfolio_factor_exposure_error', { error:String(e) }); }
}


// ----- Stub email send for alerts (no external provider integrated) -----
async function sendEmailAlert(_env: Env, _to: string, _subject: string, _body: string) {
  // Placeholder – integrate provider (Resend) later. Logged only.
  log('email_stub', { to: _to, subject: _subject });
}

// factor universe helper removed (now imported from lib/factors)

// ----- Factor IC computation (rank IC prev-day factors vs forward return) -----
// factor IC now in lib/factors

// ----- Simple backtest: rank cards by latest composite score and form top-quintile vs bottom-quintile spread cumulative -----
async function runBacktest(env: Env, params: { lookbackDays?: number, txCostBps?: number, slippageBps?: number } ) {
  const look = params.lookbackDays ?? 90;
  const txCostBps = params.txCostBps ?? 0;
  const slippageBps = params.slippageBps ?? 0; // applied similarly to tx cost (per leg)
  // Collect per-day scores (signals_daily.score) and prices to compute daily return of top vs bottom quintile each day.
  const since = isoDaysAgo(look);
  // Hard guard: limit per-day rows to cap CPU in test/CI environments. Using window function would be nicer but keep SQLite-simple.
  // Strategy: fetch all then slice top N per day in JS (N=150) which is fine for small scale; avoids complex SQL.
  const rs = await env.DB.prepare(`SELECT s.card_id, s.as_of, s.score,
    (SELECT price_usd FROM prices_daily p WHERE p.card_id=s.card_id AND p.as_of=s.as_of) AS px
    FROM signals_daily s WHERE s.as_of >= ? ORDER BY s.as_of ASC, s.score DESC`).bind(since).all();
  const rows = (rs.results||[]) as any[];
  if (!rows.length) return { ok:false, error:'no_data' };
  // group by day
  const byDay = new Map<string, any[]>();
  for (const r of rows) { const d = String(r.as_of); const arr = byDay.get(d)||[]; if (arr.length < 150) { arr.push(r); byDay.set(d, arr); } }
  const dates = Array.from(byDay.keys()).sort();
  let equity = 1; const curve: { d:string; equity:number; spreadRet:number }[] = [];
  let maxEquity = 1; let maxDrawdown = 0;
  let sumSpread = 0; let sumSqSpread = 0; let nSpread = 0;
  let prevTopIds: string[] = []; let prevBottomIds: string[] = []; let turnoverSum = 0; let turnoverDays = 0;
  for (let i=1;i<dates.length;i++) { // need prior day price to compute return; simplified using px field
    if (curve.length >= 60) break; // runtime guard: cap processed days
    const todayD = dates[i];
    const arr = byDay.get(todayD)||[];
    if (arr.length < 10) continue;
    const q = Math.floor(arr.length/5)||1;
    const top = arr.slice(0,q);
    const bottom = arr.slice(-q);
    const avg = (xs:number[])=> xs.reduce((a,b)=>a+b,0)/ (xs.length||1);
    const topPx = avg(top.map(r=> Number(r.px)||0));
    const bottomPx = avg(bottom.map(r=> Number(r.px)||0));
    // naive day-over-day diff approximated by comparing to previous day averages (not fully accurate but placeholder)
    const prevArr = byDay.get(dates[i-1])||[];
    const prevTopPx = avg(prevArr.slice(0,q).map(r=> Number(r.px)||0));
    const prevBottomPx = avg(prevArr.slice(-q).map(r=> Number(r.px)||0));
    if (prevTopPx>0 && prevBottomPx>0 && topPx>0 && bottomPx>0) {
      const retTop = (topPx - prevTopPx)/prevTopPx;
      const retBottom = (bottomPx - prevBottomPx)/prevBottomPx;
      let spread = retTop - retBottom;
      if (txCostBps > 0) spread -= (txCostBps/10000)*2; // two legs transaction cost
      if (slippageBps > 0) spread -= (slippageBps/10000)*2; // rough slippage impact
      equity *= (1 + spread);
      maxEquity = Math.max(maxEquity, equity);
      const dd = (maxEquity - equity)/maxEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;
      sumSpread += spread; sumSqSpread += spread*spread; nSpread++;
      // Approx turnover: proportion of names changed in top & bottom buckets vs previous day
      const topIds = top.map(r=> String(r.card_id));
      const bottomIds = bottom.map(r=> String(r.card_id));
      if (prevTopIds.length === topIds.length) {
        const changedTop = topIds.filter(id=> !prevTopIds.includes(id)).length / (topIds.length||1);
        const changedBottom = bottomIds.filter(id=> !prevBottomIds.includes(id)).length / (bottomIds.length||1);
        turnoverSum += (changedTop + changedBottom)/2;
        turnoverDays++;
      }
      prevTopIds = topIds; prevBottomIds = bottomIds;
      curve.push({ d: todayD, equity: +equity.toFixed(6), spreadRet: +spread.toFixed(6) });
    }
  }
  const avgSpread = nSpread ? sumSpread / nSpread : 0;
  const volSpread = nSpread ? Math.sqrt(Math.max(0, (sumSqSpread/nSpread) - avgSpread*avgSpread)) : 0;
  const sharpe = volSpread ? (avgSpread/volSpread) * Math.sqrt(252) : 0; // daily to annualized
  const turnover = turnoverDays ? turnoverSum / turnoverDays : 0;
  const metrics = { final_equity: equity, days: curve.length, avg_daily_spread: avgSpread, spread_vol: volSpread, sharpe, max_drawdown: maxDrawdown, turnover, truncated: dates.length>60 };
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO backtests (id, created_at, params, metrics, equity_curve) VALUES (?,?,?, ?, ? )`)
    .bind(id, new Date().toISOString(), JSON.stringify(params), JSON.stringify(metrics), JSON.stringify(curve)).run();
  return { ok:true, id, metrics, points: curve.length };
}

// ---------- HTTP ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const t0 = Date.now();
    // Ensure migrations at very start so routed endpoints have schema.
    await runMigrations(env.DB);
    // Router dispatch first (modularized endpoints)
    try {
      await Promise.all([
  import('./routes/factors'),
        import('./routes/admin'),
  import('./routes/anomalies'),
  import('./routes/portfolio_nav'),
  import('./routes/backfill'),
        import('./routes/public'),
        import('./routes/alerts'),
        import('./routes/metadata'),
        import('./routes/search'),
        import('./routes/subscribe'),
        import('./routes/portfolio'),
      ]);
      const { router } = await import('./router');
      const routed = await router.handle(req, env);
      if (routed) return routed;
    } catch (e) { try { console.warn('router dispatch failed', e); } catch {} }
    // Per-request evaluation (env differs by environment / binding)
    (globalThis as any).__LOG_DISABLED = (env.LOG_ENABLED === '0');
  function done(resp: Response, tag: string) {
      const ms = Date.now() - t0;
      try { log('req_timing', { path: url.pathname, tag, ms, status: resp.status }); } catch {}
      // fire & forget latency (router already records for routed paths)
      recordLatency(env, `lat.${tag}`, ms); // eslint-disable-line @typescript-eslint/no-floating-promises
      // request metrics (monolith endpoints only; routed endpoints handled in router.ts)
      (async () => { try {
        await incMetric(env, 'req.total');
        await incMetric(env, `req.status.${Math.floor(resp.status/100)}xx`);
        if (resp.status >= 500) await incMetric(env, 'request.error.5xx');
        else if (resp.status >= 400) await incMetric(env, 'request.error.4xx');
      } catch {} })();
      return resp;
    }
    if (url.pathname === '/admin/backfill' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT id, created_at, dataset, from_date, to_date, days, status, processed, total, error FROM backfill_jobs ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/ingestion/provenance' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
  const dataset = (url.searchParams.get('dataset')||'').trim();
  const source = (url.searchParams.get('source')||'').trim();
  const status = (url.searchParams.get('status')||'').trim();
  let limit = parseInt(url.searchParams.get('limit')||'100',10); if (!Number.isFinite(limit)||limit<1) limit=100; if (limit>500) limit=500;
  const where:string[] = [];
  const binds:any[] = [];
  if (dataset) { where.push('dataset = ?'); binds.push(dataset); }
  if (source) { where.push('source = ?'); binds.push(source); }
  if (status) { where.push('status = ?'); binds.push(status); }
  const whereSql = where.length ? ('WHERE '+where.join(' AND ')) : '';
  const sql = `SELECT id,dataset,source,from_date,to_date,started_at,completed_at,status,rows,error FROM ingestion_provenance ${whereSql} ORDER BY started_at DESC LIMIT ?`;
  binds.push(limit);
  const rs = await env.DB.prepare(sql).bind(...binds).all();
  return json({ ok:true, rows: rs.results||[], filtered: { dataset: dataset||undefined, source: source||undefined, status: status||undefined, limit } });
    }
    if (url.pathname === '/admin/ingestion/config' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      try {
        const rs = await env.DB.prepare(`SELECT dataset, source, cursor, enabled, last_run_at, meta FROM ingestion_config ORDER BY dataset, source`).all();
        return json({ ok:true, rows: rs.results||[] });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    }
    if (url.pathname === '/admin/ingestion/config' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
      const dataset = (body.dataset||'').toString().trim();
      const source = (body.source||'').toString().trim();
      if (!dataset || !source) return json({ ok:false, error:'dataset_and_source_required' },400);
      const cursor = body.cursor !== undefined ? String(body.cursor) : null;
      const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
      const meta = body.meta !== undefined ? JSON.stringify(body.meta).slice(0,2000) : null;
      try {
        await env.DB.prepare(`INSERT OR REPLACE INTO ingestion_config (dataset,source,cursor,enabled,last_run_at,meta) VALUES (?,?,?,?,datetime('now'),?)`)
          .bind(dataset, source, cursor, enabled, meta).run();
        const row = await env.DB.prepare(`SELECT dataset, source, cursor, enabled, last_run_at, meta FROM ingestion_config WHERE dataset=? AND source=?`).bind(dataset, source).all();
  await audit(env, { actor_type:'admin', action:'upsert', resource:'ingestion_config', resource_id:`${dataset}:${source}`, details:{ cursor, enabled } });
        return json({ ok:true, row: row.results?.[0]||null });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    }
    if (url.pathname === '/admin/ingestion/run' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
  const results = await runIncrementalIngestion(env, { maxDays: Number(body.maxDays)||1 });
  return json({ ok:true, runs: results });
    }
    if (url.pathname === '/admin/ingest/prices' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body = await req.json().catch(()=>({})) as any;
      const days = Math.min(30, Math.max(1, Number(body.days)||3));
      const to = new Date();
      const from = new Date(to.getTime() - (days-1)*86400000);
      const fromDate = from.toISOString().slice(0,10);
      const toDate = to.toISOString().slice(0,10);
      // Ensure at least one card exists (fallback synthetic)
      const cardRs = await env.DB.prepare(`SELECT id FROM cards LIMIT 50`).all();
      let cards = (cardRs.results||[]) as any[];
      if (!cards.length) {
        const cid = 'CARD-MOCK-1';
        await env.DB.prepare(`INSERT OR IGNORE INTO cards (id,name,set_id,set_name,number,rarity) VALUES (?,?,?,?,?,?)`).bind(cid,'Mock Card','mock','Mock Set','001','Promo').run();
        cards = [{ id: cid }];
      }
      // provenance row
      const provId = crypto.randomUUID();
      try { await env.DB.prepare(`INSERT INTO ingestion_provenance (id,dataset,source,from_date,to_date,started_at,status,rows) VALUES (?,?,?,?,?,datetime('now'),'running',0)`).bind(provId,'prices_daily','external-mock',fromDate,toDate).run(); } catch {}
      let inserted = 0;
      try {
        for (let i=0;i<days;i++) {
          const d = new Date(from.getTime() + i*86400000).toISOString().slice(0,10);
          for (const c of cards) {
            const have = await env.DB.prepare(`SELECT 1 FROM prices_daily WHERE card_id=? AND as_of=?`).bind((c as any).id, d).all();
            if (have.results?.length) continue;
            const latest = await env.DB.prepare(`SELECT price_usd, price_eur FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind((c as any).id).all();
            const pu = (latest.results?.[0] as any)?.price_usd || Math.random()*50+1;
            const pe = (latest.results?.[0] as any)?.price_eur || pu*0.9;
            await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind((c as any).id, d, pu, pe).run();
            inserted++;
          }
        }
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='completed', rows=?, completed_at=datetime('now') WHERE id=?`).bind(inserted, provId).run(); } catch {}
        return json({ ok:true, inserted, from_date: fromDate, to_date: toDate, provenance_id: provId });
      } catch (e:any) {
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='error', error=?, completed_at=datetime('now') WHERE id=?`).bind(String(e), provId).run(); } catch {}
        return err('ingest_failed', 500, { error_detail: String(e) });
      }
    }
  // Fire-and-forget (don't await) except for endpoints known to immediately query large tables.
    const pathname = url.pathname;
    const critical = pathname.startsWith('/api/cards') || pathname.startsWith('/api/movers') || pathname.startsWith('/api/search');
    if (critical) {
      // slight risk of adding a few ms on first query; acceptable for these endpoints
      await ensureIndices(env);
    } else {
      // async, not awaited
      ensureIndices(env); // eslint-disable-line @typescript-eslint/no-floating-promises
    }
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // (Migrations already ensured at top.)

    // Health
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
        // Defensive: ensure core tables exist (idempotent) so fresh DB doesn't 500.
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_id TEXT, set_name TEXT, number TEXT, rarity TEXT, image_url TEXT, tcgplayer_url TEXT, cardmarket_url TEXT, types TEXT);`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id,as_of));`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS svi_daily (card_id TEXT, as_of DATE, svi INTEGER, PRIMARY KEY(card_id,as_of));`)
        ]);
        const [cards, prices, signals, svi, lp, ls, lsv] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM svi_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
        ]);
        return json({
          ok: true,
          counts: {
            cards: cards.results?.[0]?.n ?? 0,
            prices_daily: prices.results?.[0]?.n ?? 0,
            signals_daily: signals.results?.[0]?.n ?? 0,
            svi_daily: svi.results?.[0]?.n ?? 0
          },
          latest: {
            prices_daily: lp.results?.[0]?.d ?? null,
            signals_daily: ls.results?.[0]?.d ?? null,
            svi_daily: lsv.results?.[0]?.d ?? null
          }
        });
      } catch (e:any) {
        log('health_error', { error: String(e) });
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // Public universe & cards
    if (url.pathname === '/api/universe' && req.method === 'GET') {
  // Ensure at least one row for smoke test / empty preview DBs
  await ensureTestSeed(env);
  await incMetric(env, 'universe.list');
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:universe"`;
      if (req.headers.get('if-none-match') === etag) {
  // Increment cache hit metric for universe endpoint
  await incMetric(env, 'cache.hit.universe');
  const notMod = new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=60', ...CORS } });
  return notMod;
      }
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types, c.number,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        ORDER BY c.set_name, c.name
        LIMIT 250
      `).all();
  const resp = json(rs.results ?? []);
  resp.headers.set('Cache-Control', 'public, max-age=60');
  resp.headers.set('ETag', etag);
  return done(resp, 'cards.list');
    }
    if (url.pathname === '/api/cards' && req.method === 'GET') {
  await ensureTestSeed(env);
  await incMetric(env, 'cards.list');
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:cards"`;
      if (req.headers.get('if-none-match') === etag) {
  await incMetric(env, 'cache.hit.cards');
  const notMod = new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=30', ...CORS } });
  return notMod;
      }
      const rs = await env.DB.prepare(`
        WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types, c.number,
               s.signal, ROUND(s.score,1) AS score,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        JOIN signals_daily s ON s.card_id=c.id, latest
        WHERE s.as_of = latest.d
        ORDER BY s.score DESC
        LIMIT 250
      `).all();
  const resp = json(rs.results ?? []);
  resp.headers.set('Cache-Control', 'public, max-age=30');
  resp.headers.set('ETag', etag);
  return done(resp, 'cards.movers');
    }

    // Movers (up/down)
    if (url.pathname === '/api/movers' && req.method === 'GET') {
  await ensureTestSeed(env);
  await incMetric(env, 'cards.movers');
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:movers"`;
      if (req.headers.get('if-none-match') === etag) {
  await incMetric(env, 'cache.hit.movers');
  const notMod = new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=30', ...CORS } });
  return notMod;
      }
      const dir = (url.searchParams.get('dir') || 'up').toLowerCase();
      const n = Math.min(50, Math.max(1, parseInt(url.searchParams.get('n') ?? '12', 10)));
      const order = dir === 'down' ? 'ASC' : 'DESC';
      const rs = await env.DB.prepare(`
        WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.number,
               s.signal, ROUND(s.score,1) AS score,
               sc.ts7, sc.z_svi,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        JOIN signals_daily s ON s.card_id=c.id
        LEFT JOIN signal_components_daily sc ON sc.card_id=c.id AND sc.as_of=s.as_of, latest
        WHERE s.as_of = latest.d
        ORDER BY COALESCE(sc.z_svi, s.edge_z, s.score) ${order}
        LIMIT ?
      `).bind(n).all();
  const resp = json(rs.results ?? []);
  resp.headers.set('Cache-Control', 'public, max-age=30');
  resp.headers.set('ETag', etag);
  return resp;
    }

    // Single card (modal)
    if (url.pathname === '/api/card' && req.method === 'GET') {
  await incMetric(env, 'card.detail');
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const [meta, p, g, v, c] = await Promise.all([
        env.DB.prepare(`SELECT id,name,set_name,rarity,image_url FROM cards WHERE id=?`).bind(id).all(),
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
      ]);
  return done(json({ ok: true, card: meta.results?.[0] ?? null, prices: p.results ?? [], signals: g.results ?? [], svi: v.results ?? [], components: c.results ?? [] }), 'card.detail');
    }

    // CSV export

  // --- Portfolio endpoints moved to routes/portfolio.ts ---
    if (url.pathname === '/admin/alert-queue/send' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_email_queue (id TEXT PRIMARY KEY, created_at TEXT, email TEXT, card_id TEXT, kind TEXT, threshold_usd REAL, status TEXT, sent_at TEXT, attempt_count INTEGER DEFAULT 0, last_error TEXT);`).run(); } catch {}
      // Select queued items that either have never been attempted or are below max attempts.
      const rs = await env.DB.prepare(`SELECT id FROM alert_email_queue WHERE status='queued' ORDER BY created_at ASC LIMIT 50`).all();
      const ids = (rs.results||[]).map((r:any)=> r.id);
      let sentCount = 0; let retryCount = 0; let giveupCount = 0;
      for (const id of ids) {
        const rowRes = await env.DB.prepare(`SELECT email, card_id, kind, threshold_usd, attempt_count FROM alert_email_queue WHERE id=?`).bind(id).all();
        const row: any = rowRes.results?.[0]; if (!row) continue;
        if (Number(row.attempt_count) >= EMAIL_RETRY_MAX) {
          // Mark terminal failure
          await env.DB.prepare(`UPDATE alert_email_queue SET status='error', last_error=COALESCE(last_error,'max_attempts'), sent_at=datetime('now') WHERE id=?`).bind(id).run();
          giveupCount++;
          continue;
        }
        const subj = `PokeQuant Alert: ${row.card_id} ${row.kind} ${row.threshold_usd}`;
        const body = `<p>Card <b>${row.card_id}</b> triggered <b>${row.kind}</b> at threshold ${row.threshold_usd}.</p>`;
        const sendRes = await sendEmail(env, row.email, subj, body);
        if (sendRes.ok) {
          await env.DB.prepare(`UPDATE alert_email_queue SET status='sent', sent_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?`).bind(id).run();
          sentCount++;
        } else {
          const attemptsSql = `UPDATE alert_email_queue SET attempt_count=attempt_count+1, last_error=?, sent_at=CASE WHEN attempt_count+1>=? THEN datetime('now') ELSE sent_at END, status=CASE WHEN attempt_count+1>=? THEN 'error' ELSE 'queued' END WHERE id=?`;
          await env.DB.prepare(attemptsSql).bind(sendRes.error||'error', EMAIL_RETRY_MAX, EMAIL_RETRY_MAX, id).run();
          if ((Number(row.attempt_count)+1) >= EMAIL_RETRY_MAX) giveupCount++; else retryCount++;
        }
      }
      if (sentCount) incMetricBy(env, 'alert.sent', sentCount);
      if (retryCount) incMetricBy(env, 'email.retry', retryCount);
      if (giveupCount) incMetricBy(env, 'email.giveup', giveupCount);
      await audit(env, { actor_type:'admin', action:'process', resource:'alert_email_queue', details:{ processed: ids.length, sent: sentCount, retry: retryCount, giveup: giveupCount } });
      return json({ ok:true, processed: ids.length, sent: sentCount, retry: retryCount, giveup: giveupCount });
    }
    if (url.pathname === '/alerts/deactivate' && (req.method === 'GET' || req.method === 'POST')) {
      const body: any = req.method === 'POST' ? await req.json().catch(()=>({})) : {};
      const id = req.method === 'GET' ? (url.searchParams.get('id') || '').trim() : (body.id ? String(body.id).trim() : '');
      const token = req.method === 'GET' ? (url.searchParams.get('token') || '').trim() : (body.token ? String(body.token).trim() : '');
  if (!id || !token) return err('id_and_token_required');
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
      const mt = row.results?.[0]?.manage_token as string | undefined;
  if (!mt || mt !== token) return err('invalid_token', 403);
      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
  if (req.method === 'GET') {
        const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px">
          <h3>Alert deactivated.</h3>
          <p><a href="${env.PUBLIC_BASE_URL || '/'}">Back to PokeQuant</a></p>
        </body>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS }});
      }
  log('alert_deactivated', { id });
  await audit(env, { actor_type:'public', action:'deactivate', resource:'alert', resource_id:id });
  return json({ ok: true });
    }

    // Ingest Trends (GitHub Action)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
      const body: any = await req.json().catch(()=>({}));
      const rows = body && Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return json({ ok: true, rows: 0 });
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)`).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok: true, rows: rows.length });
    }

    // ---- Admin: diagnostics & runs ----
    if (url.pathname === '/admin/diag' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      const [svi14, pr1, pr7, sigLast, lp, ls, lsv] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM svi_daily GROUP BY card_id HAVING COUNT(*) >= 14)`).all(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 1)`).all(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 7)`).all(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily))`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
      ]);
      return json({
        ok: true,
        cards_with_svi14_plus: svi14.results?.[0]?.n ?? 0,
        cards_with_price1_plus: pr1.results?.[0]?.n ?? 0,
        cards_with_price7_plus: pr7.results?.[0]?.n ?? 0,
        signals_rows_latest: sigLast.results?.[0]?.n ?? 0,
        latest_price_date: lp.results?.[0]?.d ?? null,
        latest_signal_date: ls.results?.[0]?.d ?? null,
        latest_svi_date: lsv.results?.[0]?.d ?? null
      });
    }

    // Metrics (recent 3 days)
    if (url.pathname === '/admin/metrics' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        const rs = await env.DB.prepare(`SELECT d, metric, count FROM metrics_daily WHERE d >= date('now','-3 day') ORDER BY d DESC, metric ASC`).all();
        // Latency summary (if view exists)
        let latency: any[] = [];
        try {
          const lrs = await env.DB.prepare(`SELECT d, base_metric, p50_ms, p95_ms FROM metrics_latency WHERE d >= date('now','-3 day') ORDER BY d DESC, base_metric ASC`).all();
          latency = lrs.results || [];
        } catch { /* view may not exist yet */ }
  // Derive simple cache hit rate summary for front-end: group metrics with prefix cache.hit.
  const cacheHits = (rs.results||[]).filter((r:any)=> typeof r.metric === 'string' && r.metric.startsWith('cache.hit.'));
  // Derive simple ratios if base metrics exist (e.g., universe.list vs cache.hit.universe)
  const baseMap = new Map<string, number>();
  for (const r of (rs.results||[]) as any[]) {
    if (typeof r.metric === 'string') baseMap.set(r.metric, Number(r.count)||0);
  }
  const ratios: Record<string, number> = {};
  const pairs: [string,string][] = [
    ['universe','universe.list'],
    ['cards','cards.list'],
    ['movers','cards.movers'],
    ['sets','sets'],
    ['rarities','rarities'],
    ['types','types']
  ];
  for (const [short, base] of pairs) {
    const hit = baseMap.get(`cache.hit.${short}`) || 0;
    const total = (baseMap.get(base) || 0) + hit; // base metric increments on normal 200s; hits only added on 304
    if (total > 0) ratios[short] = +(hit / total).toFixed(3);
  }
  return json({ ok:true, rows: rs.results || [], latency, cache_hits: cacheHits, cache_hit_ratios: ratios });
      } catch {
        return json({ ok:true, rows: [] });
      }
    }

    if (url.pathname === '/admin/latency' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        const rs = await env.DB.prepare(`SELECT d, base_metric, p50_ms, p95_ms FROM metrics_latency WHERE d = date('now') ORDER BY base_metric ASC`).all();
        return json({ ok:true, rows: rs.results || [] });
      } catch {
        return json({ ok:true, rows: [] });
      }
    }

    // Admin test utility: force legacy portfolio auth by nulling secret_hash for a portfolio id
    if (url.pathname === '/admin/portfolio/force-legacy' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const pid = (body.id||'').toString();
      if (!pid) return json({ ok:false, error:'id_required' },400);
      try {
        // Ensure portfolios table & column exist
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
        try { await env.DB.prepare(`ALTER TABLE portfolios ADD COLUMN secret_hash TEXT`).run(); } catch {/* ignore */}
        const row = await env.DB.prepare(`SELECT secret, secret_hash FROM portfolios WHERE id=?`).bind(pid).all();
        if (!row.results?.length) return json({ ok:false, error:'not_found' },404);
        const hadHash = !!(row.results[0] as any).secret_hash;
        if (hadHash) {
          await env.DB.prepare(`UPDATE portfolios SET secret_hash=NULL WHERE id=?`).bind(pid).run();
        }
        await audit(env, { actor_type:'admin', action:'force_legacy', resource:'portfolio', resource_id:pid, details:{ hadHash } });
        return json({ ok:true, id: pid, had_hash: hadHash });
      } catch (e:any) {
        return json({ ok:false, error:String(e) },500);
      }
    }

    // Data integrity snapshot (coverage + staleness + gap heuristic)
    if (url.pathname === '/admin/integrity' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
  const integrity = await computeIntegritySnapshot(env);
  return json(integrity);
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Retention (on-demand purge) - returns number of deleted rows per table
    if (url.pathname === '/admin/retention' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      let overrides: Record<string, number>|undefined;
      try {
        const body: any = await req.json().catch(()=> ({}));
        if (body && typeof body === 'object' && body.windows && typeof body.windows === 'object') {
          overrides = {};
          for (const [k,v] of Object.entries(body.windows)) {
            const days = Number(v);
            if (Number.isFinite(days) && days >= 0 && days <= 365) overrides[k] = Math.floor(days);
          }
        }
      } catch { /* ignore */ }
      const t0r = Date.now();
      const deleted = await purgeOldData(env, overrides);
      const dur = Date.now() - t0r;
  await audit(env, { actor_type:'admin', action:'purge', resource:'retention', resource_id:null, details: { deleted, ms: dur, overrides } });
      // Record metrics per table deleted >0
      for (const [table, n] of Object.entries(deleted)) {
        if (n>0) incMetricBy(env, `retention.deleted.${table}`, n); // eslint-disable-line @typescript-eslint/no-floating-promises
      }
      recordLatency(env, 'job.retention', dur); // latency tracking bucket
      return json({ ok:true, deleted, ms: dur, overrides: overrides && Object.keys(overrides).length ? overrides : undefined });
    }


    // Migrations list
    if (url.pathname === '/admin/migrations' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rows = await listMigrations(env.DB);
      return json({ ok:true, rows });
    }

    if (url.pathname === '/admin/version' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      // Spec version duplicated in openapi.yaml (info.version). Keeping a single source via APP_VERSION.
      return json({ ok:true, version: APP_VERSION });
    }

  // (Factor weights CRUD endpoints removed in favor of routes/factors.ts)

    // Run alerts only (for tests / manual)
    if (url.pathname === '/admin/run-alerts' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      try {
        const out = await runAlerts(env);
        log('admin_run_alerts', out);
        return json({ ok:true, ...out });
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

  // (factor IC, summary, returns endpoints removed; now provided by routes/factors.ts)
  // (factor risk, metrics, returns-smoothed endpoints removed; handled by routes/factors.ts)
  // (signal-quality, factor-performance endpoints removed; provided by routes/factors.ts)
    // Test support: generic row insert into allowlisted tables (non-prod usage)
    if (url.pathname === '/admin/test-insert' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const table = (body.table||'').toString();
      const rows = Array.isArray(body.rows) ? body.rows : [];
  const allow = new Set(['signal_components_daily','factor_returns','portfolio_nav','portfolio_factor_exposure','factor_ic','anomalies']);
      if (!allow.has(table)) return json({ ok:false, error:'table_not_allowed' },400);
      if (!rows.length) return json({ ok:false, error:'no_rows' },400);
      for (const r of rows) {
        const cols = Object.keys(r).filter(k=> /^[a-zA-Z0-9_]+$/.test(k));
        if (!cols.length) continue;
        const placeholders = cols.map(()=> '?').join(',');
        const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
        const stmt = env.DB.prepare(sql).bind(...cols.map(c=> (r as any)[c]));
        await stmt.run();
      }
      return json({ ok:true, inserted: rows.length, table });
    }
    if (url.pathname === '/admin/portfolio-exposure/snapshot' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await snapshotPortfolioFactorExposure(env);
      return json({ ok:true });
    }

    // Factor config CRUD
    if (url.pathname === '/admin/factors' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
  // Defensive: ensure table exists (tests may hit before migrations finalized per worker instance)
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
      const rs = await env.DB.prepare(`SELECT factor, enabled, display_name, created_at FROM factor_config ORDER BY factor ASC`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/factors' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const factor = (body.factor||'').toString().trim();
      const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
      const display = body.display_name ? String(body.display_name).trim() : null;
      if (!factor || !/^[-_a-zA-Z0-9]{2,32}$/.test(factor)) return json({ ok:false, error:'invalid_factor' },400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO factor_config (factor, enabled, display_name, created_at) VALUES (?,?,?, COALESCE((SELECT created_at FROM factor_config WHERE factor=?), datetime('now')))`) .bind(factor, enabled, display, factor).run();
  await audit(env, { actor_type:'admin', action:'upsert', resource:'factor_config', resource_id:factor, details:{ enabled } });
  return json({ ok:true, factor, enabled, display_name: display });
    }
    if (url.pathname === '/admin/factors/toggle' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const factor = (body.factor||'').toString().trim();
      const enabled = body.enabled ? 1 : 0;
      if (!factor) return json({ ok:false, error:'factor_required' },400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
      await env.DB.prepare(`UPDATE factor_config SET enabled=? WHERE factor=?`).bind(enabled, factor).run();
  await audit(env, { actor_type:'admin', action:'toggle', resource:'factor_config', resource_id:factor, details:{ enabled } });
  return json({ ok:true, factor, enabled });
    }
    if (url.pathname === '/admin/factors/delete' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const factor = (body.factor||'').toString().trim();
      if (!factor) return json({ ok:false, error:'factor_required' },400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
      await env.DB.prepare(`DELETE FROM factor_config WHERE factor=?`).bind(factor).run();
  await audit(env, { actor_type:'admin', action:'delete', resource:'factor_config', resource_id:factor });
  return json({ ok:true, factor });
    }

    // Ingestion schedule config
    if (url.pathname === '/admin/ingestion-schedule' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_schedule (dataset TEXT PRIMARY KEY, frequency_minutes INTEGER, last_run_at TEXT);`).run();
      const rs = await env.DB.prepare(`SELECT dataset, frequency_minutes, last_run_at FROM ingestion_schedule ORDER BY dataset`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/ingestion-schedule' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const dataset = (body.dataset||'').toString();
      const freq = Number(body.frequency_minutes);
      if (!dataset || !Number.isFinite(freq)) return json({ ok:false, error:'dataset_and_frequency_required' },400);
      await env.DB.prepare(`INSERT OR REPLACE INTO ingestion_schedule (dataset, frequency_minutes, last_run_at) VALUES (?,?,COALESCE((SELECT last_run_at FROM ingestion_schedule WHERE dataset=?), NULL))`).bind(dataset, freq, dataset).run();
      await audit(env, { actor_type:'admin', action:'set_schedule', resource:'ingestion_schedule', resource_id:dataset, details:{ freq } });
      return json({ ok:true, dataset, frequency_minutes: freq });
    }
    if (url.pathname === '/admin/ingestion-schedule/run-due' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_schedule (dataset TEXT PRIMARY KEY, frequency_minutes INTEGER, last_run_at TEXT);`).run();
      const nowIso = new Date().toISOString();
      const dueRs = await env.DB.prepare(`SELECT dataset, frequency_minutes, last_run_at FROM ingestion_schedule`).all();
      const due: string[] = [];
      for (const r of (dueRs.results||[]) as any[]) {
        const last = r.last_run_at ? Date.parse(r.last_run_at) : 0;
        const mins = Number(r.frequency_minutes)||0;
        if (!mins) continue;
        if (Date.now() - last >= mins*60000) due.push(String(r.dataset));
      }
      // For MVP just update last_run_at and increment metric
      const body:any = await req.json().catch(()=>({}));
      const runFlag = body.run === true || body.run === 1 || body.run === '1' || url.searchParams.get('run') === '1';
      for (const d of due) {
        await env.DB.prepare(`UPDATE ingestion_schedule SET last_run_at=? WHERE dataset=?`).bind(nowIso, d).run();
        incMetric(env, 'ingest.scheduled_run');
      }
      let ingestRuns: any[]|undefined;
      if (runFlag && due.length) {
        ingestRuns = await runIncrementalIngestion(env, { datasets: due, maxDays: 1 });
      }
      return json({ ok:true, ran: due, ingested: ingestRuns });
    }
    // Admin: list alerts with filters
    if (url.pathname === '/admin/alerts' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await ensureAlertsTable(env);
      const email = (url.searchParams.get('email')||'').trim();
      const active = url.searchParams.get('active'); // '1' | '0'
      const suppressed = url.searchParams.get('suppressed'); // '1' | '0'
      const where: string[] = [];
      const binds: any[] = [];
      if (email) { where.push('email=?'); binds.push(email); }
      if (active === '1' || active === '0') { where.push('active=?'); binds.push(Number(active)); }
      if (suppressed === '1') { where.push('suppressed_until IS NOT NULL AND suppressed_until > datetime(\'now\')'); }
      if (suppressed === '0') { where.push('(suppressed_until IS NULL OR suppressed_until < datetime(\'now\'))'); }
      const sql = `SELECT id,email,card_id,kind,active,${await getAlertThresholdCol(env)} AS threshold,suppressed_until,last_fired_at,fired_count FROM alerts_watch ${where.length? 'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC LIMIT 200`;
      const rs = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    // Admin: alert stats summary
    if (url.pathname === '/admin/alerts/stats' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await ensureAlertsTable(env);
      const rs = await env.DB.prepare(`SELECT active, suppressed_until, fired_count FROM alerts_watch`).all();
      let total=0, activeCount=0, suppressed=0; let ge5=0, ge10=0, ge25=0;
      for (const r of (rs.results||[]) as any[]) {
        total++;
        const act = Number(r.active)||0; if (act) activeCount++;
        const sup = r.suppressed_until && Date.parse(String(r.suppressed_until)) > Date.now(); if (sup) suppressed++;
        const fc = Number(r.fired_count)||0;
        if (fc>=5) ge5++; if (fc>=10) ge10++; if (fc>=25) ge25++;
      }
      return json({ ok:true, total, active: activeCount, suppressed, active_unsuppressed: activeCount - suppressed, escalation:{ ge5, ge10, ge25 } });
    }

    // Run backtest
    if (url.pathname === '/admin/backtests' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const lookbackDays = Number(body.lookbackDays)||90;
  const txCostBps = Number(body.txCostBps)||0;
  const slippageBps = Number(body.slippageBps)||0;
  const out = await runBacktest(env, { lookbackDays, txCostBps, slippageBps });
  await audit(env, { actor_type:'admin', action:'backtest_run', resource:'backtest', resource_id: (out as any).id||null, details:{ lookbackDays } });
  return json(out);
    }
    if (url.pathname === '/admin/backtests' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT id, created_at, params, metrics FROM backtests ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname.startsWith('/admin/backtests/') && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const id = url.pathname.split('/').pop() || '';
      const rs = await env.DB.prepare(`SELECT id, created_at, params, metrics, equity_curve FROM backtests WHERE id=?`).bind(id).all();
      return json({ ok:true, row: rs.results?.[0]||null });
    }

    // Snapshot endpoint (metadata bundle)
    if (url.pathname === '/admin/snapshot' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const [integrity, ic, weights] = await Promise.all([
  computeIntegritySnapshot(env),
        env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic ORDER BY as_of DESC, factor ASC LIMIT 30`).all(),
        env.DB.prepare(`SELECT version, factor, weight, active FROM factor_weights WHERE active=1`).all()
      ]);
      const factorReturns = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns ORDER BY as_of DESC, factor ASC LIMIT 60`).all();
      return json({ ok:true, integrity, factor_ic: (ic as any).results||[], active_weights: (weights as any).results||[], factor_returns: (factorReturns.results||[]) });
    }

    // Test seed utility (not documented) to insert cards & prices
    if (url.pathname === '/admin/test-seed' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const cards = Array.isArray(body.cards) ? body.cards : [];
      const batch: D1PreparedStatement[] = [];
  // Ensure tables
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, rarity TEXT, image_url TEXT, types TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`).run();
      for (const c of cards) {
        if (!c.id) continue;
        batch.push(env.DB.prepare(`INSERT OR REPLACE INTO cards (id,name,set_name,rarity,image_url,types) VALUES (?,?,?,?,?,?)`).bind(c.id, c.name||c.id, c.set_name||null, c.rarity||null, null, null));
        if (c.price_usd !== undefined) {
          const as_of = (c.as_of && /^\d{4}-\d{2}-\d{2}$/.test(c.as_of)) ? c.as_of : new Date().toISOString().slice(0,10);
          batch.push(env.DB.prepare(`INSERT OR REPLACE INTO prices_daily (card_id, as_of, price_usd) VALUES (?,?,?)`).bind(c.id, as_of, c.price_usd));
        }
      }
      if (batch.length) await env.DB.batch(batch);
      return json({ ok:true, inserted: cards.length });
    }

    // NEW: fast, bulk compute only (safe warm)
    if (url.pathname === '/admin/run-fast' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
  // Ensure minimal seed data exists to allow IC/backtest tests to proceed quickly
  const cardCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all();
  if ((cardCount.results?.[0] as any)?.n === 0) {
    // Insert a small deterministic set of 5 mock cards and a few days of prices
    const today = new Date();
    const cards = Array.from({length:5}).map((_,i)=> ({ id:`SEED-${i+1}`, name:`Seed Card ${i+1}`, set_name:'Seed', rarity:'Promo' }));
    for (let idx=0; idx<cards.length; idx++) {
      const c = cards[idx];
      await env.DB.prepare(`INSERT OR IGNORE INTO cards (id,name,set_name,rarity) VALUES (?,?,?,?)`).bind(c.id,c.name,c.set_name,c.rarity).run();
      for (let d=4; d>=0; d--) {
        const day = new Date(today.getTime() - d*86400000).toISOString().slice(0,10);
  const base = 20 + idx*2 + d; // pseudo variation
        await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind(c.id, day, base, base*0.9).run();
      }
    }
  }
  const out = await computeSignalsBulk(env, 120);
  log('admin_run_fast', out);
  return json({ ok: true, ...out });
      } catch (e:any) {
  log('admin_run_fast_error', { error: String(e) });
  return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Full pipeline (may hit subrequest caps if upstream is slow)
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        const out = await pipelineRun(env);
        log('admin_run_pipeline', out.timingsMs);
  await audit(env, { actor_type:'admin', action:'pipeline_run', resource:'pipeline', resource_id: new Date().toISOString().slice(0,10), details: out.timingsMs });
  return json(out);
      } catch (e:any) {
        log('admin_run_pipeline_error', { error: String(e) });
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Audit log listing endpoint
    if (url.pathname === '/admin/audit' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const resource = (url.searchParams.get('resource')||'').trim();
      const action = (url.searchParams.get('action')||'').trim();
      const actorType = (url.searchParams.get('actor_type')||'').trim();
      const resourceId = (url.searchParams.get('resource_id')||'').trim();
      const beforeTs = (url.searchParams.get('before_ts')||'').trim();
      let limit = parseInt(url.searchParams.get('limit')||'200',10); if (!Number.isFinite(limit)||limit<1) limit=100; if (limit>500) limit=500;
      const where: string[] = []; const binds: any[] = [];
      if (resource) { where.push('resource=?'); binds.push(resource); }
      if (action) { where.push('action=?'); binds.push(action); }
      if (actorType) { where.push('actor_type=?'); binds.push(actorType); }
      if (resourceId) { where.push('resource_id=?'); binds.push(resourceId); }
      if (beforeTs) { where.push('ts < ?'); binds.push(beforeTs); }
      const sql = `SELECT id, ts, actor_type, actor_id, action, resource, resource_id, details FROM mutation_audit ${where.length? 'WHERE '+where.join(' AND '):''} ORDER BY ts DESC LIMIT ?`;
      binds.push(limit);
      try {
        const rs = await env.DB.prepare(sql).bind(...binds).all();
        const rows = (rs.results||[]) as any[];
        const next = rows.length === limit ? rows[rows.length-1].ts : null;
        return json({ ok:true, rows, page: { next_before_ts: next }, filtered:{ resource:resource||undefined, action:action||undefined, actor_type: actorType||undefined, resource_id: resourceId||undefined, limit, before_ts: beforeTs||undefined } });
      } catch (e:any) {
        return json({ ok:false, error:String(e) },500);
      }
    }
    if (url.pathname === '/admin/audit/stats' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const hours = Math.min(168, Math.max(1, parseInt(url.searchParams.get('hours')||'24',10)));
      try {
        const cutoff = new Date(Date.now() - hours*3600*1000).toISOString();
        const rs = await env.DB.prepare(`SELECT action, resource, COUNT(*) AS n FROM mutation_audit WHERE ts >= ? GROUP BY action, resource ORDER BY n DESC LIMIT 100`).bind(cutoff).all();
        const totals = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit WHERE ts >= ?`).bind(cutoff).all();
        return json({ ok:true, hours, total: totals.results?.[0]?.n||0, rows: rs.results||[] });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    }
    // Test-only helper to emit audit entries (not documented) - guarded by admin token
    if (url.pathname === '/admin/test-audit' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
      audit(env, { actor_type: body.actor_type||'test', action: body.action||'emit', resource: body.resource||'test_event', resource_id: body.resource_id||null, details: body.details });
      return json({ ok:true });
    }

    // Factor correlations (admin) based on factor_returns rolling window
    if (url.pathname === '/admin/factor-correlations' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const look = Math.min(180, Math.max(5, parseInt(url.searchParams.get('days')||'60',10)));
      try {
        const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ?) ORDER BY as_of ASC`).bind(`-${look-1} day`).all();
        const rows = (rs.results||[]) as any[];
        const byFactor: Record<string, {d:string; r:number}[]> = {};
        for (const r of rows) { const f=String(r.factor); const d=String(r.as_of); const v=Number(r.ret); if (!Number.isFinite(v)) continue; (byFactor[f] ||= []).push({ d, r:v }); }
        const factors = Object.keys(byFactor).sort();
        if (factors.length < 2) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:0 } });
        // Align on intersection of dates where all factors have data
        const dateSets = factors.map(f=> new Set(byFactor[f].map(o=> o.d)));
        const allDates = Array.from(new Set(rows.map(r=> String(r.as_of)))).sort();
        const usable = allDates.filter(d=> dateSets.every(s=> s.has(d)));
        const series: number[][] = factors.map(()=> []);
        for (const d of usable) {
          factors.forEach((f,idx)=> { const v = byFactor[f].find(o=> o.d===d)?.r; series[idx].push(v ?? 0); });
        }
        const n = usable.length;
        if (n < 5) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:n } });
        function mean(a:number[]) { return a.reduce((s,x)=>s+x,0)/a.length; }
        function corr(a:number[], b:number[]) {
          const ma = mean(a), mb = mean(b); let num=0,da=0,db=0; for (let i=0;i<a.length;i++){ const x=a[i]-ma,y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
          const den = Math.sqrt(da*db)||0; return den? num/den : 0;
        }
        const matrix: number[][] = [];
        for (let i=0;i<factors.length;i++) { matrix[i]=[]; for (let j=0;j<factors.length;j++){ matrix[i][j] = +(corr(series[i], series[j])).toFixed(4); } }
        let sumAbs=0; let pairs=0; for (let i=0;i<matrix.length;i++) for (let j=i+1;j<matrix.length;j++){ sumAbs+=Math.abs(matrix[i][j]); pairs++; }
        const avgAbs = pairs? +(sumAbs/pairs).toFixed(4): null;
        return json({ ok:true, factors, days:n, matrix, stats:{ avg_abs_corr: avgAbs } });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    }

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    try {
  const bulk = await computeSignalsBulk(env, 365);
  await runAlerts(env);
  await updateDataCompleteness(env);
  await computeFactorIC(env); // daily IC update
  await computeFactorReturns(env); // daily factor returns
  await computeFactorRiskModel(env); // rolling cov/corr + vol/beta
  await smoothFactorReturns(env); // smoothed factor returns snapshot
  await computeSignalQuality(env); // IC stability metrics
  await detectAnomalies(env);
  await snapshotPortfolioNAV(env);
  await computePortfolioPnL(env);
  await snapshotPortfolioFactorExposure(env);
  const t0r = Date.now();
  const deleted = await purgeOldData(env); // apply retention daily (lightweight DELETEs)
  const rMs = Date.now() - t0r;
  for (const [table, n] of Object.entries(deleted)) {
    if (n>0) incMetricBy(env, `retention.deleted.${table}`, n); // eslint-disable-line @typescript-eslint/no-floating-promises
  }
  recordLatency(env, 'job.retention', rMs);
  log('cron_run', bulk);
    } catch (e) {
  log('cron_error', { error: String(e) });
    }
  }
};

