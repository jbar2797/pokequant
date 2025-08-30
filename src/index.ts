// src/index.ts
// PokeQuant Worker — bulk compute to avoid subrequest limits.
// Public API preserved; adds POST /admin/run-fast to compute signals only, safely.

import { compositeScore } from './signal_math';
import { APP_VERSION } from './version';
import { z } from 'zod';
import { runMigrations, listMigrations } from './migrations';
// Structured logging helper (can be disabled via LOG_ENABLED=0)
function log(event: string, fields: Record<string, unknown> = {}) {
  if ((globalThis as any).__LOG_DISABLED) return;
  try { console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields })); } catch { /* noop */ }
}

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string; // e.g., https://pokequant.pages.dev
  LOG_ENABLED?: string; // '0' to disable structured logs
  // Optional rate limit overrides (all integers as strings)
  RL_SEARCH_LIMIT?: string;      // default 30
  RL_SEARCH_WINDOW_SEC?: string; // default 300
  RL_SUBSCRIBE_LIMIT?: string;   // default 5
  RL_SUBSCRIBE_WINDOW_SEC?: string; // default 86400
  RL_ALERT_CREATE_LIMIT?: string;   // default 10
  RL_ALERT_CREATE_WINDOW_SEC?: string; // default 86400
}

// ---------- utils ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });
}
function err(code: string, status = 400, extra: Record<string, unknown> = {}) {
  return json({ ok: false, error: code, ...extra }, status);
}
function isoDaysAgo(days: number) {
  const d = new Date(Date.now() - Math.max(0, days)*86400000);
  return d.toISOString().slice(0,10);
}

// Shared signature for ETag generation across public endpoints.
// Includes counts and latest dates across multiple tables so cache busts when any base dataset changes.
// Format: v2:<cardCount>:<latestPrice>:<latestSignal>:<latestSvi>:<latestComponents>
async function baseDataSignature(env: Env): Promise<string> {
  try {
    const rs = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM cards) AS cards,
      (SELECT MAX(as_of) FROM prices_daily) AS lp,
      (SELECT MAX(as_of) FROM signals_daily) AS ls,
      (SELECT MAX(as_of) FROM svi_daily) AS lv,
      (SELECT MAX(as_of) FROM signal_components_daily) AS lc`).all();
    const row: any = rs.results?.[0] || {};
    return `v2:${row.cards||0}:${row.lp||''}:${row.ls||''}:${row.lv||''}:${row.lc||''}`;
  } catch {
    return 'v2:0::::';
  }
}

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
interface RateLimitResult { allowed: boolean; remaining: number; limit: number; reset: number; }
async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER);`).run();
    const now = Math.floor(Date.now()/1000);
    const windowStart = now - (now % windowSec);
    await env.DB.prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
        window_start = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.window_start ELSE excluded.window_start END
    `).bind(key, windowStart).run();
    const row = await env.DB.prepare(`SELECT window_start, count FROM rate_limits WHERE key=?`).bind(key).all();
    const ws = Number(row.results?.[0]?.window_start) || windowStart;
    const count = Number(row.results?.[0]?.count) || 0;
    const reset = ws + windowSec; // epoch seconds
    const remaining = Math.max(0, limit - count);
    if (count > limit) return { allowed: false, remaining: 0, limit, reset };
    return { allowed: true, remaining, limit, reset };
  } catch (e) {
    log('rate_limit_error', { key, error: String(e) });
    return { allowed: true, remaining: limit, limit, reset: Math.floor(Date.now()/1000)+windowSec };
  }
}
function getRateLimits(env: Env) {
  // Parse helper
  const p = (v: string|undefined, d: number) => { const n = parseInt(v||'',10); return Number.isFinite(n) && n>0 ? n : d; };
  return {
    search: { limit: p(env.RL_SEARCH_LIMIT, 30), window: p(env.RL_SEARCH_WINDOW_SEC, 300) },
    subscribe: { limit: p(env.RL_SUBSCRIBE_LIMIT, 5), window: p(env.RL_SUBSCRIBE_WINDOW_SEC, 86400) },
    alertCreate: { limit: p(env.RL_ALERT_CREATE_LIMIT, 10), window: p(env.RL_ALERT_CREATE_WINDOW_SEC, 86400) }
  } as const;
}

// ---------- metrics (simple daily counter in D1) ----------
async function incMetric(env: Env, metric: string) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
    const today = new Date().toISOString().slice(0,10);
    await env.DB.prepare(
      `INSERT INTO metrics_daily (d, metric, count) VALUES (?, ?, 1)
       ON CONFLICT(d,metric) DO UPDATE SET count = count + 1`
    ).bind(today, metric).run();
  } catch (e) {
    log('metric_error', { metric, error: String(e) });
  }
}
// Record latency using exponential smoothing for approximate p50/p95 stored as separate metrics.
async function recordLatency(env: Env, tag: string, ms: number) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
    const today = new Date().toISOString().slice(0,10);
    const p50Key = `${tag}.p50`; // reuse count column to store value * 1000 (int)
    const p95Key = `${tag}.p95`;
    const alpha50 = 0.2, alpha95 = 0.1;
    const fetchVal = async (k:string) => {
      const r = await env.DB.prepare(`SELECT count FROM metrics_daily WHERE d=? AND metric=?`).bind(today, k).all();
      return Number(r.results?.[0]?.count) || 0;
    };
    const cur50 = await fetchVal(p50Key);
    const cur95 = await fetchVal(p95Key);
    const new50 = cur50 === 0 ? ms*1000 : Math.round((1-alpha50)*cur50 + alpha50*ms*1000);
    const estP95 = Math.max(ms*1000, cur95 === 0 ? ms*1000 : Math.round((1-alpha95)*cur95 + alpha95*ms*1000* (ms*1000>cur95?1:0.5)));
    const upsert = async (k:string, v:number) => {
      await env.DB.prepare(`INSERT INTO metrics_daily (d,metric,count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count=?`).bind(today,k,v,v).run();
    };
    await upsert(p50Key, new50);
    await upsert(p95Key, estP95);
  } catch (e) {
    log('metric_latency_error', { tag, error: String(e) });
  }
}

// Lazy test seeding (only if DB empty / tables missing) to allow unit tests to pass without migration step.
async function ensureTestSeed(env: Env) {
  try {
    const check = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cards'`).all();
    const tableExists = !!(check.results && check.results.length);
    if (!tableExists) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, rarity TEXT, image_url TEXT, types TEXT);`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id,as_of));`).run();
    }
    // Seed if zero rows (helps local preview & smoke tests)
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all().catch(()=>({ results: [{ n: 0 }] } as any));
    const n = Number(count.results?.[0]?.n) || 0;
    if (n === 0) {
      await env.DB.prepare(`INSERT INTO cards (id,name,set_name,rarity,image_url,types) VALUES ('card1','Test Card','Test Set','Promo',NULL,'Fire');`).run();
    }
  } catch { /* ignore in prod */ }
}

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

// ---------- Alerts (defensive) ----------
async function ensureAlertsTable(env: Env) {
  // Create full shape if missing; safe if exists.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS alerts_watch (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT DEFAULT 'price_below',
      threshold_usd REAL,
      active INTEGER DEFAULT 1,
      manage_token TEXT,
      created_at TEXT,
      last_fired_at TEXT
    );
  `).run();
}

// Determine which threshold column exists (backwards compat: older deployments used 'threshold')
async function getAlertThresholdCol(env: Env): Promise<'threshold_usd'|'threshold'> {
  try {
    const rs = await env.DB.prepare(`PRAGMA table_info('alerts_watch')`).all();
    const cols = (rs.results||[]).map((r:any)=> (r.name||r.cid||'').toString());
    if (cols.includes('threshold_usd')) return 'threshold_usd';
    if (cols.includes('threshold')) return 'threshold';
  } catch {}
  return 'threshold_usd';
}

async function runAlerts(env: Env) {
  await ensureAlertsTable(env);
  const col = await getAlertThresholdCol(env);
  const rs = await env.DB.prepare(`
    SELECT a.id, a.email, a.card_id, a.kind, a.${col} as threshold,
           (SELECT COALESCE(price_usd, price_eur) FROM prices_daily p WHERE p.card_id=a.card_id ORDER BY as_of DESC LIMIT 1) AS px
    FROM alerts_watch a
    WHERE a.active=1
  `).all();
  let fired = 0;
  for (const a of (rs.results ?? []) as any[]) {
    const px = Number(a.px);
    const th = Number(a.threshold);
    if (!Number.isFinite(px) || !Number.isFinite(th)) continue;
    const kind = String(a.kind || 'price_below');
    const hit = (kind === 'price_below') ? (px <= th) : (px >= th);
    if (!hit) continue;
    await env.DB.prepare(`UPDATE alerts_watch SET last_fired_at=datetime('now') WHERE id=?`).bind(a.id).run();
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

// ----- Data completeness ledger helpers -----
async function updateDataCompleteness(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS data_completeness (dataset TEXT, as_of DATE, rows INTEGER, PRIMARY KEY(dataset,as_of));`).run();
    const today = new Date().toISOString().slice(0,10);
    const datasets: [string,string][] = [
      ['prices_daily','SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?'],
      ['signals_daily','SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?'],
      ['svi_daily','SELECT COUNT(*) AS n FROM svi_daily WHERE as_of=?'],
      ['signal_components_daily','SELECT COUNT(*) AS n FROM signal_components_daily WHERE as_of=?']
    ];
    for (const [ds, sql] of datasets) {
      const r = await env.DB.prepare(sql).bind(today).all();
      const n = Number(r.results?.[0]?.n)||0;
      await env.DB.prepare(`INSERT OR REPLACE INTO data_completeness (dataset, as_of, rows) VALUES (?,?,?)`).bind(ds, today, n).run();
    }
  } catch (e) {
    log('data_completeness_update_error', { error: String(e) });
  }
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

// ----- Portfolio NAV snapshot -----
async function snapshotPortfolioNAV(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_nav (portfolio_id TEXT, as_of DATE, market_value REAL, PRIMARY KEY(portfolio_id,as_of));`).run();
    const ports = await env.DB.prepare(`SELECT id FROM portfolios`).all();
    const today = new Date().toISOString().slice(0,10);
    for (const p of (ports.results||[]) as any[]) {
      const lots = await env.DB.prepare(`SELECT l.card_id,l.qty,(SELECT price_usd FROM prices_daily px WHERE px.card_id=l.card_id ORDER BY as_of DESC LIMIT 1) AS px FROM lots l WHERE l.portfolio_id=?`).bind(p.id).all();
      let mv=0; for (const r of (lots.results||[]) as any[]) { mv += (Number(r.px)||0) * (Number(r.qty)||0); }
      await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_nav (portfolio_id, as_of, market_value) VALUES (?,?,?)`).bind(p.id, today, mv).run();
    }
  } catch (e) { log('portfolio_nav_error', { error:String(e) }); }
}

// Factor returns: compute top-bottom quintile forward return per enabled factor (using previous day factor values and forward price move)
async function computeFactorReturns(env: Env) {
  try {
    const factorUniverse = await getFactorUniverse(env);
    if (!factorUniverse.length) return { ok:false, skipped:true };
    const meta = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest)) SELECT (SELECT d FROM prev) AS prev_d, (SELECT d FROM latest) AS latest_d`).all();
    const mrow = (meta.results||[])[0] as any; if (!mrow?.prev_d || !mrow?.latest_d) return { ok:false, skipped:true };
    const prevDay = mrow.prev_d as string; const nextDay = mrow.latest_d as string;
    // Skip if already computed for all factors
    const existing = await env.DB.prepare(`SELECT COUNT(*) AS c FROM factor_returns WHERE as_of=?`).bind(prevDay).all();
    if (((existing.results||[])[0] as any)?.c >= factorUniverse.length) return { ok:true, skipped:true };
    // Pull component + price data for prev day
    const rs = await env.DB.prepare(`SELECT sc.card_id, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90,
      (SELECT price_usd FROM prices_daily WHERE card_id=sc.card_id AND as_of=?) AS px_prev,
      (SELECT price_usd FROM prices_daily WHERE card_id=sc.card_id AND as_of=?) AS px_next
      FROM signal_components_daily sc WHERE sc.as_of=?`).bind(prevDay, nextDay, prevDay).all();
    const rows = (rs.results||[]) as any[]; if (!rows.length) return { ok:false, skipped:true };
    const forwardRet = (r:any)=> { const a=Number(r.px_prev)||0; const b=Number(r.px_next)||0; return (a>0 && b>0)? (b-a)/a : null; };
    const factorValue = (r:any, f:string) => {
      if (f==='risk') return r.vol;
      return r[f];
    };
    for (const factor of factorUniverse) {
      const usable = rows.filter(r=> Number.isFinite(factorValue(r,factor)) && Number.isFinite(forwardRet(r)));
      if (usable.length < 10) continue;
      const sorted = usable.slice().sort((a,b)=> Number(factorValue(a,factor)) - Number(factorValue(b,factor)));
      const q = Math.max(1, Math.floor(sorted.length/5));
      const bottom = sorted.slice(0,q);
      const top = sorted.slice(-q);
      const avg = (arr:any[])=> arr.reduce((s,x)=> s + (forwardRet(x)||0),0)/(arr.length||1);
      const ret = avg(top) - avg(bottom);
      await env.DB.prepare(`INSERT OR REPLACE INTO factor_returns (as_of, factor, ret) VALUES (?,?,?)`).bind(prevDay, factor, ret).run();
    }
    return { ok:true, as_of: prevDay };
  } catch (e) {
    log('factor_returns_error', { error:String(e) });
    return { ok:false, error:String(e) };
  }
}

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

// Dynamic factor universe helper (persisted in factor_config)
async function getFactorUniverse(env: Env): Promise<string[]> {
  try {
    const rs = await env.DB.prepare(`SELECT factor FROM factor_config WHERE enabled=1`).all();
    const rows = (rs.results||[]) as any[];
    if (rows.length) return rows.map(r=> String(r.factor));
  } catch {/* ignore */}
  return ['ts7','ts30','z_svi','risk','liquidity','scarcity','mom90'];
}

// ----- Factor IC computation (rank IC prev-day factors vs forward return) -----
async function computeFactorIC(env: Env) {
  try {
    // Forward return IC: use factor values on day D (prev) vs return from D to D+1 (latest)
    const meta = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest)) SELECT (SELECT d FROM prev) AS prev_d, (SELECT d FROM latest) AS latest_d`).all();
    const metaRow = (meta.results||[])[0] as any;
    if (!metaRow || !metaRow.prev_d || !metaRow.latest_d) return { ok:false, skipped:true };
    const prevDay = metaRow.prev_d as string;
    const latestDay = metaRow.latest_d as string;
  const factorUniverse = await getFactorUniverse(env);
    // Skip if already computed for prevDay (all factors present)
    const existing = await env.DB.prepare(`SELECT COUNT(*) AS c FROM factor_ic WHERE as_of=?`).bind(prevDay).all();
    if (((existing.results||[])[0] as any)?.c >= factorUniverse.length) return { ok:true, skipped:true, already:true };
    const rs = await env.DB.prepare(`SELECT p.card_id,
        (SELECT price_usd FROM prices_daily WHERE card_id=p.card_id AND as_of=?) AS px_prev,
        (SELECT price_usd FROM prices_daily WHERE card_id=p.card_id AND as_of=?) AS px_next,
        (SELECT ts7 FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS ts7,
        (SELECT ts30 FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS ts30,
        (SELECT z_svi FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS z_svi,
        (SELECT vol FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS vol,
        (SELECT liquidity FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS liquidity,
        (SELECT scarcity FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS scarcity,
        (SELECT mom90 FROM signal_components_daily sc WHERE sc.card_id=p.card_id AND sc.as_of=?) AS mom90
      FROM prices_daily p
      WHERE p.as_of=?`).bind(prevDay, latestDay, prevDay, prevDay, prevDay, prevDay, prevDay, prevDay, prevDay, prevDay).all();
    const rows = (rs.results||[]) as any[];
    if (!rows.length) return { ok:false, skipped:true };
    const rets: number[] = [];
    for (const r of rows) {
      const a = Number(r.px_prev)||0, b=Number(r.px_next)||0;
      rets.push(a>0 && b>0 ? (b-a)/a : 0);
    }
    if (rets.filter(x=>x!==0).length < 3) return { ok:false, skipped:true };
    function rankIC(fvals: number[]): number|null {
      const data: { v:number; r:number }[] = [];
      for (let i=0;i<fvals.length;i++) {
        const fv = fvals[i]; const rv = rets[i];
        if (Number.isFinite(fv) && Number.isFinite(rv)) data.push({ v: fv, r: rv });
      }
      const n = data.length;
      if (n < 5) return null;
      const idxF = data.map((_,i)=> i).sort((a,b)=> data[a].v - data[b].v);
      const idxR = data.map((_,i)=> i).sort((a,b)=> data[a].r - data[b].r);
      const rankF = new Array(n); const rankR = new Array(n);
      for (let i=0;i<n;i++){ rankF[idxF[i]] = i+1; rankR[idxR[i]] = i+1; }
      let sumF=0,sumR=0; for (let i=0;i<n;i++){ sumF+=rankF[i]; sumR+=rankR[i]; }
      const mF = sumF/n, mR = sumR/n; let num=0,dF=0,dR=0;
      for (let i=0;i<n;i++){ const a1=rankF[i]-mF,b1=rankR[i]-mR; num+=a1*b1; dF+=a1*a1; dR+=b1*b1; }
      const den = Math.sqrt(dF*dR)||0; if (!den) return null; return num/den;
    }
    const baseMaps: Record<string, number[]> = {
      ts7: rows.map(r=> Number(r.ts7)),
      ts30: rows.map(r=> Number(r.ts30)),
      z_svi: rows.map(r=> Number(r.z_svi)),
      risk: rows.map(r=> Number(r.vol)),
      liquidity: rows.map(r=> Number(r.liquidity)),
      scarcity: rows.map(r=> Number(r.scarcity)),
      mom90: rows.map(r=> Number(r.mom90))
    };
    const factors: Record<string, number|null> = {};
    for (const f of factorUniverse) {
      if (baseMaps[f]) factors[f] = rankIC(baseMaps[f]);
    }
    for (const [f, ic] of Object.entries(factors)) {
      if (ic === null) continue;
      await env.DB.prepare(`INSERT OR REPLACE INTO factor_ic (as_of,factor,ic) VALUES (?,?,?)`).bind(prevDay, f, ic).run();
    }
    return { ok:true, factors, as_of: prevDay, forward_to: latestDay };
  } catch (e) {
    log('factor_ic_error', { error:String(e) });
    return { ok:false, error:String(e) };
  }
}

// ----- Simple backtest: rank cards by latest composite score and form top-quintile vs bottom-quintile spread cumulative -----
async function runBacktest(env: Env, params: { lookbackDays?: number, txCostBps?: number, slippageBps?: number } ) {
  const look = params.lookbackDays ?? 90;
  const txCostBps = params.txCostBps ?? 0;
  const slippageBps = params.slippageBps ?? 0; // applied similarly to tx cost (per leg)
  // Collect per-day scores (signals_daily.score) and prices to compute daily return of top vs bottom quintile each day.
  const since = isoDaysAgo(look);
  const rs = await env.DB.prepare(`SELECT s.card_id, s.as_of, s.score,
    (SELECT price_usd FROM prices_daily p WHERE p.card_id=s.card_id AND p.as_of=s.as_of) AS px
    FROM signals_daily s WHERE s.as_of >= ? ORDER BY s.as_of ASC, s.score DESC`).bind(since).all();
  const rows = (rs.results||[]) as any[];
  if (!rows.length) return { ok:false, error:'no_data' };
  // group by day
  const byDay = new Map<string, any[]>();
  for (const r of rows) { const d = String(r.as_of); const arr = byDay.get(d)||[]; arr.push(r); byDay.set(d, arr); }
  const dates = Array.from(byDay.keys()).sort();
  let equity = 1; const curve: { d:string; equity:number; spreadRet:number }[] = [];
  let maxEquity = 1; let maxDrawdown = 0;
  let sumSpread = 0; let sumSqSpread = 0; let nSpread = 0;
  let prevTopIds: string[] = []; let prevBottomIds: string[] = []; let turnoverSum = 0; let turnoverDays = 0;
  for (let i=1;i<dates.length;i++) { // need prior day price to compute return; simplified using px field
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
  const metrics = { final_equity: equity, days: curve.length, avg_daily_spread: avgSpread, spread_vol: volSpread, sharpe, max_drawdown: maxDrawdown, turnover };
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
  // Per-request evaluation (env differs by environment / binding)
  (globalThis as any).__LOG_DISABLED = (env.LOG_ENABLED === '0');
    function done(resp: Response, tag: string) {
      try { log('req_timing', { path: url.pathname, tag, ms: Date.now() - t0, status: resp.status }); } catch {}
  recordLatency(env, `lat.${tag}`, Date.now() - t0); // fire & forget
      return resp;
    }
    // Opportunistically ensure indices for first request hitting an isolate.
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

  // Ensure migrations early (before heavy queries)
  await runMigrations(env.DB);

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
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types,
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
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types,
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
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
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
    if (url.pathname === '/research/card-csv' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const [pRs, sRs, gRs, cRs] = await Promise.all([
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
      ]);
      const map = new Map<string, any>();
      for (const r of (pRs.results ?? [])) map.set((r as any).d, { d: (r as any).d, usd: (r as any).usd ?? '', eur: (r as any).eur ?? '' });
      for (const r of (sRs.results ?? [])) { const row = map.get((r as any).d) || (map.set((r as any).d, { d: (r as any).d }).get((r as any).d)); row.svi = (r as any).svi ?? ''; }
      for (const r of (gRs.results ?? [])) { const row = map.get((r as any).d) || (map.set((r as any).d, { d: (r as any).d }).get((r as any).d)); row.signal = (r as any).signal ?? ''; row.score = (r as any).score ?? ''; row.edge_z = (r as any).edge_z ?? ''; row.exp_ret = (r as any).exp_ret ?? ''; row.exp_sd = (r as any).exp_sd ?? ''; }
      for (const r of (cRs.results ?? [])) { const row = map.get((r as any).d) || (map.set((r as any).d, { d: (r as any).d }).get((r as any).d)); row.ts7 = (r as any).ts7 ?? ''; row.ts30 = (r as any).ts30 ?? ''; row.dd = (r as any).dd ?? ''; row.vol = (r as any).vol ?? ''; row.z_svi = (r as any).z_svi ?? ''; }

      const dates = Array.from(map.keys()).sort();
      const header = ['date','price_usd','price_eur','svi','signal','score','edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'];
      const lines = [header.join(',')];
      for (const d of dates) {
        const r = map.get(d);
        lines.push([d, r.usd ?? '', r.eur ?? '', r.svi ?? '', r.signal ?? '', r.score ?? '', r.edge_z ?? '', r.exp_ret ?? '', r.exp_sd ?? '', r.ts7 ?? '', r.ts30 ?? '', r.dd ?? '', r.vol ?? '', r.z_svi ?? ''].join(','));
      }
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${id}_last${days}d.csv"`, ...CORS }});
    }

    // Subscribe
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
  const ip = req.headers.get('cf-connecting-ip') || 'anon';
  const rlKey = `sub:${ip}`;
  const cfg = getRateLimits(env).subscribe;
  const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
  if (!rl.allowed) { await incMetric(env, 'rate_limited.subscribe'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) }, 429); }
      const body: any = await req.json().catch(()=>({}));
      const email = (body && body.email ? String(body.email) : '').trim();
  if (!email) return err('email_required', 400);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, kind TEXT, target TEXT, created_at TEXT);`).run();
      const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR REPLACE INTO subscriptions (id, kind, target, created_at) VALUES (?, 'email', ?, datetime('now'))`).bind(id, email).run();
  log('subscribe', { email });
  await incMetric(env, 'subscribe');
  return done(json({ ok: true }), 'subscribe');
    }

    // Alerts create/deactivate
    if (url.pathname === '/alerts/create' && req.method === 'POST') {
      await ensureAlertsTable(env);
  const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const body: any = await req.json().catch(()=>({}));
      const email = body && body.email ? String(body.email).trim() : '';
      const card_id = body && body.card_id ? String(body.card_id).trim() : '';
      const kind = body && body.kind ? String(body.kind).trim() : 'price_below';
      const threshold = body && body.threshold !== undefined ? Number(body.threshold) : NaN;
  if (!email || !card_id) return err('email_and_card_id_required');
  if (!Number.isFinite(threshold)) return err('threshold_invalid');
  const rlKey = `alert:${ip}:${email}`;
  const cfg = getRateLimits(env).alertCreate;
  const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
  if (!rl.allowed) { await incMetric(env, 'rate_limited.alert_create'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) }, 429); }
      const id = crypto.randomUUID();
      const tokenBytes = new Uint8Array(16); crypto.getRandomValues(tokenBytes);
      const manage_token = Array.from(tokenBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      // Dynamic column insert
      const col = await getAlertThresholdCol(env);
      await env.DB.prepare(
        `INSERT INTO alerts_watch (id,email,card_id,kind,${col},active,manage_token,created_at) VALUES (?,?,?,?,?,1,?,datetime('now'))`
      ).bind(id, email, card_id, kind, threshold, manage_token).run();
      const manage_url = `${env.PUBLIC_BASE_URL || ''}/alerts/deactivate?id=${encodeURIComponent(id)}&token=${encodeURIComponent(manage_token)}`;
  log('alert_created', { id, card_id, kind, threshold });
  await incMetric(env, 'alert.created');
  return done(json({ ok: true, id, manage_token, manage_url }), 'alerts.create');
    }

    // --- Search & metadata endpoints (MVP completion) ---
    if (url.pathname === '/api/sets' && req.method === 'GET') {
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:sets"`;
      if (req.headers.get('if-none-match') === etag) {
  await incMetric(env, 'cache.hit.sets');
  return new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
      }
      const rs = await env.DB.prepare(`SELECT set_name AS v, COUNT(*) AS n FROM cards GROUP BY set_name ORDER BY n DESC`).all();
  const resp = json(rs.results || []);
  resp.headers.set('Cache-Control', 'public, max-age=300');
  resp.headers.set('ETag', etag);
  return done(resp, 'sets');
    }
    if (url.pathname === '/api/rarities' && req.method === 'GET') {
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:rarities"`;
      if (req.headers.get('if-none-match') === etag) {
  await incMetric(env, 'cache.hit.rarities');
  return new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
      }
      const rs = await env.DB.prepare(`SELECT rarity AS v, COUNT(*) AS n FROM cards GROUP BY rarity ORDER BY n DESC`).all();
  const resp = json(rs.results || []);
  resp.headers.set('Cache-Control', 'public, max-age=300');
  resp.headers.set('ETag', etag);
  return done(resp, 'rarities');
    }
    if (url.pathname === '/api/types' && req.method === 'GET') {
      await ensureTestSeed(env);
      const sig = await baseDataSignature(env);
      const etag = `"${sig}:types"`;
      if (req.headers.get('if-none-match') === etag) {
  await incMetric(env, 'cache.hit.types');
  return new Response(null, { status:304, headers: { 'ETag': etag, 'Cache-Control': 'public, max-age=300', ...CORS } });
      }
      const rs = await env.DB.prepare(`SELECT DISTINCT types FROM cards WHERE types IS NOT NULL`).all();
      const out: { v: string }[] = [];
      for (const r of (rs.results||[]) as any[]) {
        const parts = String(r.types||'').split('|').filter(Boolean);
        for (const p of parts) out.push({ v: p });
      }
  const resp = json(out);
  resp.headers.set('Cache-Control', 'public, max-age=300');
  resp.headers.set('ETag', etag);
  return done(resp, 'types');
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      await ensureTestSeed(env);
  const ip = req.headers.get('cf-connecting-ip') || 'anon';
  const rlKey = `search:${ip}`;
  const cfg = getRateLimits(env).search;
  const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
  if (!rl.allowed) { await incMetric(env, 'rate_limited.search'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) }, 429); }
      const q = (url.searchParams.get('q')||'').trim();
      const rarity = (url.searchParams.get('rarity')||'').trim();
      const setName = (url.searchParams.get('set')||'').trim();
      const type = (url.searchParams.get('type')||'').trim();
      let limit = parseInt(url.searchParams.get('limit')||'50',10); if (!Number.isFinite(limit)||limit<1) limit=50; if (limit>250) limit=250;
      const where: string[] = [];
      const binds: any[] = [];
  // Some test seeds may not include 'number' column; prefer dynamic safe pattern
  if (q) { where.push('(c.name LIKE ? OR c.id LIKE ?)'); const like = `%${q}%`; binds.push(like, like); }
      if (rarity) { where.push('c.rarity = ?'); binds.push(rarity); }
      if (setName) { where.push('c.set_name = ?'); binds.push(setName); }
      if (type) { where.push('c.types LIKE ?'); binds.push(`%${type}%`); }
      const whereSql = where.length ? 'WHERE '+ where.join(' AND ') : '';
      const sql = `WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
        SELECT c.id,c.name,c.set_name,c.rarity,c.image_url,c.types,
          (SELECT s.signal FROM signals_daily s WHERE s.card_id=c.id AND s.as_of=latest.d) AS signal,
          (SELECT ROUND(s.score,1) FROM signals_daily s WHERE s.card_id=c.id AND s.as_of=latest.d) AS score,
          (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
          (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c, latest
        ${whereSql}
        ORDER BY COALESCE(score,0) DESC
        LIMIT ?`;
      binds.push(limit);
      const rs = await env.DB.prepare(sql).bind(...binds).all();
  await incMetric(env, 'search.query');
  return done(json(rs.results || []), 'search');
    }

    // --- Portfolio endpoints (capability token model) ---
    if (url.pathname === '/portfolio/create' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const secretBytes = new Uint8Array(16); crypto.getRandomValues(secretBytes);
      const secret = Array.from(secretBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      await env.DB.prepare(`INSERT INTO portfolios (id, secret, created_at) VALUES (?,?,datetime('now'))`).bind(id, secret).run();
      return json({ id, secret });
    }
    if (url.pathname === '/portfolio/add-lot' && req.method === 'POST') {
      const pid = req.headers.get('x-portfolio-id')||'';
      const psec = req.headers.get('x-portfolio-secret')||'';
      const body = await req.json().catch(()=>({}));
      const LotSchema = z.object({ card_id: z.string().min(1), qty: z.number().positive(), cost_usd: z.number().min(0), acquired_at: z.string().optional() });
      const parsed = LotSchema.safeParse(body);
      if (!parsed.success) return json({ ok:false, error:'invalid_body', issues: parsed.error.issues },400);
      const okRow = await env.DB.prepare(`SELECT 1 FROM portfolios WHERE id=? AND secret=?`).bind(pid,psec).all();
      if (!(okRow.results||[]).length) return json({ ok:false, error:'forbidden' },403);
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lots (id TEXT PRIMARY KEY, portfolio_id TEXT, card_id TEXT, qty REAL, cost_usd REAL, acquired_at TEXT, note TEXT);`).run();
      const lotId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO lots (id, portfolio_id, card_id, qty, cost_usd, acquired_at) VALUES (?,?,?,?,?,?)`).bind(lotId, pid, parsed.data.card_id, parsed.data.qty, parsed.data.cost_usd, parsed.data.acquired_at || null).run();
  log('portfolio_lot_added', { portfolio: pid, lot: lotId, card: parsed.data.card_id });
  return json({ ok:true, lot_id: lotId });
    }
    if (url.pathname === '/portfolio' && req.method === 'GET') {
      const pid = req.headers.get('x-portfolio-id')||'';
      const psec = req.headers.get('x-portfolio-secret')||'';
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      const okRow = await env.DB.prepare(`SELECT 1 FROM portfolios WHERE id=? AND secret=?`).bind(pid,psec).all();
      if (!(okRow.results||[]).length) return json({ ok:false, error:'forbidden' },403);
      const lots = await env.DB.prepare(`SELECT l.id AS lot_id,l.card_id,l.qty,l.cost_usd,l.acquired_at,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=l.card_id ORDER BY as_of DESC LIMIT 1) AS price_usd
        FROM lots l WHERE l.portfolio_id=?`).bind(pid).all();
      let mv=0, cost=0; for (const r of (lots.results||[]) as any[]) { const px = Number(r.price_usd)||0; mv += px * Number(r.qty); cost += Number(r.cost_usd)||0; }
      return json({ ok:true, totals:{ market_value: mv, cost_basis: cost, unrealized: mv-cost }, rows: lots.results||[] });
    }
    if (url.pathname === '/portfolio/export' && req.method === 'GET') {
      const pid = req.headers.get('x-portfolio-id')||'';
      const psec = req.headers.get('x-portfolio-secret')||'';
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      const okRow = await env.DB.prepare(`SELECT 1 FROM portfolios WHERE id=? AND secret=?`).bind(pid,psec).all();
      if (!(okRow.results||[]).length) return json({ ok:false, error:'forbidden' },403);
      const lots = await env.DB.prepare(`SELECT * FROM lots WHERE portfolio_id=?`).bind(pid).all();
      return json({ ok:true, portfolio_id: pid, lots: lots.results||[] });
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

    // Data integrity snapshot (coverage + staleness + gap heuristic)
    if (url.pathname === '/admin/integrity' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        // Core latest dates
        const [cards, lp, ls, lsv, lc, cp, cs, csv, cc] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all(),
          env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM prices_daily WHERE as_of=(SELECT MAX(as_of) FROM prices_daily)`).all(),
          env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily)`).all(),
          env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM svi_daily WHERE as_of=(SELECT MAX(as_of) FROM svi_daily)`).all(),
          env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM signal_components_daily WHERE as_of=(SELECT MAX(as_of) FROM signal_components_daily)`).all()
        ]);
        const today = new Date().toISOString().slice(0,10);
        // Gap heuristic: expected distinct days in last 30 window (adjust if dataset newer than 30d)
        const windowDays = 30;
        const gapQuery = async (table: string) => {
          try {
            const res = await env.DB.prepare(`SELECT MIN(as_of) AS min_d, COUNT(DISTINCT as_of) AS days FROM ${table} WHERE as_of >= date('now','-${windowDays-1} day')`).all();
            const row: any = res.results?.[0] || {};
            const minD = row.min_d as string | null;
            const distinct = Number(row.days)||0;
            let expected = windowDays;
            if (minD) {
              const ms = (Date.parse(today) - Date.parse(minD));
              if (Number.isFinite(ms)) {
                const spanDays = Math.floor(ms/86400000)+1;
                if (spanDays < expected) expected = spanDays;
              }
            }
            return Math.max(0, expected - distinct);
          } catch { return 0; }
        };
        const [gp, gs, gsv, gcc] = await Promise.all([
          gapQuery('prices_daily'),
          gapQuery('signals_daily'),
          gapQuery('svi_daily'),
          gapQuery('signal_components_daily')
        ]);
        const latest = {
          prices_daily: lp.results?.[0]?.d || null,
          signals_daily: ls.results?.[0]?.d || null,
          svi_daily: lsv.results?.[0]?.d || null,
          signal_components_daily: lc.results?.[0]?.d || null
        } as Record<string,string|null>;
        const stale: string[] = [];
        const staleThresholdDays = 2;
        for (const [k,v] of Object.entries(latest)) {
          if (v) {
            const age = Math.floor((Date.parse(today) - Date.parse(v))/86400000);
            if (age > staleThresholdDays) stale.push(k);
          }
        }
        // Pull completeness ledger (last 14 days)
        let completeness: any[] = [];
        try {
          const crs = await env.DB.prepare(`SELECT dataset, as_of, rows FROM data_completeness WHERE as_of >= date('now','-13 day') ORDER BY as_of DESC, dataset`).all();
          completeness = crs.results || [];
        } catch { /* ignore */ }
        return json({
          ok: true,
            total_cards: cards.results?.[0]?.n ?? 0,
            latest,
            coverage_latest: {
              prices_daily: cp.results?.[0]?.n ?? 0,
              signals_daily: cs.results?.[0]?.n ?? 0,
              svi_daily: csv.results?.[0]?.n ?? 0,
              signal_components_daily: cc.results?.[0]?.n ?? 0
            },
            gaps_last_30: {
              prices_daily: gp,
              signals_daily: gs,
              svi_daily: gsv,
              signal_components_daily: gcc
            },
            stale,
            completeness
        });
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Anomalies list
    if (url.pathname === '/admin/anomalies' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT as_of, card_id, kind, magnitude FROM anomalies ORDER BY as_of DESC LIMIT 200`).all();
      return json({ ok:true, rows: rs.results||[] });
    }

    // Portfolio NAV history (admin)
    if (url.pathname === '/admin/portfolio-nav' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT portfolio_id, as_of, market_value FROM portfolio_nav ORDER BY as_of DESC LIMIT 500`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/portfolio-nav/snapshot' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await snapshotPortfolioNAV(env);
      return json({ ok:true });
    }

    // Backfill jobs
    if (url.pathname === '/admin/backfill' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const dataset = (body.dataset||'prices_daily').toString();
      const days = Math.min(365, Math.max(1, Number(body.days)||30));
      const to = new Date();
      const from = new Date(Date.now() - (days-1)*86400000);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO backfill_jobs (id, created_at, dataset, from_date, to_date, days, status, processed, total) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id, new Date().toISOString(), dataset, from.toISOString().slice(0,10), to.toISOString().slice(0,10), days, 'pending', 0, days).run();
      // Kick off inline processing (synchronous simplified) - simulate fill of missing rows (no external fetch yet)
      try {
        for (let i=0;i<days;i++) {
          const d = new Date(from.getTime() + i*86400000).toISOString().slice(0,10);
          // If dataset is prices_daily ensure at least one synthetic price row for existing cards (idempotent)
          if (dataset === 'prices_daily') {
            const cards = await env.DB.prepare(`SELECT id FROM cards LIMIT 50`).all();
            for (const c of (cards.results||[]) as any[]) {
              // Skip if already present
              const have = await env.DB.prepare(`SELECT 1 FROM prices_daily WHERE card_id=? AND as_of=?`).bind(c.id, d).all();
              if (have.results?.length) continue;
              // Simple synthetic backfill: copy latest known price
              const latest = await env.DB.prepare(`SELECT price_usd, price_eur FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind(c.id).all();
              const pu = (latest.results?.[0] as any)?.price_usd || Math.random()*50+1;
              const pe = (latest.results?.[0] as any)?.price_eur || pu*0.9;
              await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind(c.id, d, pu, pe).run();
            }
          }
          // Update job progress
          await env.DB.prepare(`UPDATE backfill_jobs SET processed=? WHERE id=?`).bind(i+1, id).run();
        }
        await env.DB.prepare(`UPDATE backfill_jobs SET status='completed' WHERE id=?`).bind(id).run();
      } catch (e:any) {
        await env.DB.prepare(`UPDATE backfill_jobs SET status='error', error=? WHERE id=?`).bind(String(e), id).run();
      }
      const job = await env.DB.prepare(`SELECT * FROM backfill_jobs WHERE id=?`).bind(id).all();
      return json({ ok:true, job: job.results?.[0] });
    }
    if (url.pathname === '/admin/backfill' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rows = await env.DB.prepare(`SELECT id,dataset,from_date,to_date,days,status,processed,total,created_at FROM backfill_jobs ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rows.results||[] });
    }
    if (url.pathname.startsWith('/admin/backfill/') && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const id = url.pathname.split('/').pop();
      const row = await env.DB.prepare(`SELECT * FROM backfill_jobs WHERE id=?`).bind(id).all();
      return json({ ok:true, job: row.results?.[0]||null });
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

    // List factor weights
    if (url.pathname === '/admin/factor-weights' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      try {
        const rs = await env.DB.prepare(`SELECT version, factor, weight, active, created_at FROM factor_weights ORDER BY version DESC, factor ASC`).all();
        return json({ ok:true, rows: rs.results||[] });
      } catch (e:any) {
        return json({ ok:false, error:String(e) },500);
      }
    }
    // Upsert factor weights (overwrite version)
    if (url.pathname === '/admin/factor-weights' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const version = (body.version || new Date().toISOString().slice(0,19).replace(/[:T]/g,'').replace(/-/g,''));
      const weights = Array.isArray(body.weights) ? body.weights : [];
      if (!weights.length) return json({ ok:false, error:'weights_required' },400);
      // deactivate previous active
      try {
        await env.DB.prepare(`UPDATE factor_weights SET active=0 WHERE active=1`).run();
        for (const w of weights) {
          if (!w.factor || typeof w.weight !== 'number') continue;
          await env.DB.prepare(`INSERT OR REPLACE INTO factor_weights (version,factor,weight,active,created_at) VALUES (?,?,?,?,datetime('now'))`).bind(version, String(w.factor), Number(w.weight), 1).run();
        }
        return json({ ok:true, version, count: weights.length });
      } catch (e:any) {
        return json({ ok:false, error:String(e) },500);
      }
    }
    // Auto compute factor weights based on trailing IC magnitudes
    if (url.pathname === '/admin/factor-weights/auto' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      let q = await env.DB.prepare(`SELECT factor, AVG(ABS(ic)) AS strength FROM factor_ic WHERE as_of >= date('now','-29 day') GROUP BY factor`).all();
      let rows = (q.results||[]) as any[];
      try {
        const enabled = await getFactorUniverse(env);
        rows = rows.filter(r=> enabled.includes(String(r.factor)));
      } catch {/* ignore */}
      if (!rows.length) {
        // Try to compute IC now, then re-query (broader window)
        await computeFactorIC(env);
        q = await env.DB.prepare(`SELECT factor, AVG(ABS(ic)) AS strength FROM factor_ic WHERE as_of >= date('now','-90 day') GROUP BY factor`).all();
        rows = (q.results||[]) as any[];
        try {
          const enabled = await getFactorUniverse(env);
          rows = rows.filter(r=> enabled.includes(String(r.factor)));
        } catch {/* ignore */}
      }
      if (!rows.length) {
        // Fallback: derive equal weights for default factors present in latest components row
        let comp = await env.DB.prepare(`SELECT ts7, ts30, z_svi FROM signal_components_daily ORDER BY as_of DESC LIMIT 1`).all();
        if (!comp.results?.length) {
          // generate a snapshot so fallback succeeds
            try { await computeSignalsBulk(env, 30); } catch {/* ignore */}
            comp = await env.DB.prepare(`SELECT ts7, ts30, z_svi FROM signal_components_daily ORDER BY as_of DESC LIMIT 1`).all();
        }
  // Even if still empty, proceed with synthetic baseline factors
  const factorsFallback = ['ts7','ts30','z_svi'];
        rows = factorsFallback.map(f=> ({ factor: f, strength: 1 }));
      }
      const sum = rows.reduce((a,r)=> a + (Number(r.strength)||0),0) || 1;
      const genVersion = 'auto'+ new Date().toISOString().slice(0,19).replace(/[:T]/g,'').replace(/-/g,'');
      await env.DB.prepare(`UPDATE factor_weights SET active=0 WHERE active=1`).run();
      for (const r of rows) {
        const w = (Number(r.strength)||0)/sum;
        await env.DB.prepare(`INSERT OR REPLACE INTO factor_weights (version,factor,weight,active,created_at) VALUES (?,?,?,?,datetime('now'))`).bind(genVersion, r.factor, w, 1).run();
      }
      return json({ ok:true, version: genVersion, factors: rows.length });
    }

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

    // Factor IC on demand
    if (url.pathname === '/admin/factor-ic/run' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const out = await computeFactorIC(env);
      return json(out);
    }
    if (url.pathname === '/admin/factor-ic' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic ORDER BY as_of DESC, factor ASC LIMIT 300`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/factor-ic/summary' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT factor, COUNT(*) AS n, AVG(ic) AS avg_ic, AVG(ABS(ic)) AS avg_abs_ic FROM factor_ic WHERE as_of >= date('now','-90 day') GROUP BY factor`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/factor-returns' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns ORDER BY as_of DESC, factor ASC LIMIT 400`).all();
      return json({ ok:true, rows: rs.results||[] });
    }
    if (url.pathname === '/admin/factor-returns/run' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const out = await computeFactorReturns(env);
      return json(out);
    }
    if (url.pathname === '/admin/portfolio-exposure/snapshot' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      await snapshotPortfolioFactorExposure(env);
      return json({ ok:true });
    }

    // Factor config CRUD
    if (url.pathname === '/admin/factors' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
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
      await env.DB.prepare(`INSERT OR REPLACE INTO factor_config (factor, enabled, display_name, created_at) VALUES (?,?,?, COALESCE((SELECT created_at FROM factor_config WHERE factor=?), datetime('now')))`) .bind(factor, enabled, display, factor).run();
      return json({ ok:true, factor, enabled, display_name: display });
    }
    if (url.pathname === '/admin/factors/toggle' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const factor = (body.factor||'').toString().trim();
      const enabled = body.enabled ? 1 : 0;
      if (!factor) return json({ ok:false, error:'factor_required' },400);
      await env.DB.prepare(`UPDATE factor_config SET enabled=? WHERE factor=?`).bind(enabled, factor).run();
      return json({ ok:true, factor, enabled });
    }
    if (url.pathname === '/admin/factors/delete' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const factor = (body.factor||'').toString().trim();
      if (!factor) return json({ ok:false, error:'factor_required' },400);
      await env.DB.prepare(`DELETE FROM factor_config WHERE factor=?`).bind(factor).run();
      return json({ ok:true, factor });
    }

    // Portfolio factor exposure (simple latest component averages weighted by holdings)
    if (url.pathname === '/portfolio/exposure' && req.method === 'GET') {
      const pid = req.headers.get('x-portfolio-id')||'';
      const psec = req.headers.get('x-portfolio-secret')||'';
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      const okRow = await env.DB.prepare(`SELECT 1 FROM portfolios WHERE id=? AND secret=?`).bind(pid,psec).all();
      if (!(okRow.results||[]).length) return json({ ok:false, error:'forbidden' },403);
      const latest = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all();
      const d = (latest.results?.[0] as any)?.d;
      if (!d) return json({ ok:true, as_of:null, exposures:{} });
      // Join lots with latest components and approximate factor exposures by quantity weighting
      const rs = await env.DB.prepare(`SELECT l.card_id,l.qty, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90 FROM lots l LEFT JOIN signal_components_daily sc ON sc.card_id=l.card_id AND sc.as_of=? WHERE l.portfolio_id=?`).bind(d, pid).all();
      const rows = (rs.results||[]) as any[];
      let totalQty = 0; const agg: Record<string,{w:number; sum:number}> = {};
      const factors = ['ts7','ts30','z_svi','vol','liquidity','scarcity','mom90'];
      for (const r of rows) { const q = Number(r.qty)||0; if (q<=0) continue; totalQty += q; for (const f of factors) { const v = Number((r as any)[f]); if (!Number.isFinite(v)) continue; const slot = agg[f] || (agg[f] = { w:0, sum:0 }); slot.w += q; slot.sum += v*q; } }
      const out: Record<string, number|null> = {};
      for (const f of factors) { const a = agg[f]; out[f] = a && a.w>0 ? +(a.sum/a.w).toFixed(6) : null; }
      return json({ ok:true, as_of:d, exposures: out });
    }
    if (url.pathname === '/portfolio/exposure/history' && req.method === 'GET') {
      const pid = req.headers.get('x-portfolio-id')||'';
      const psec = req.headers.get('x-portfolio-secret')||'';
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      const okRow = await env.DB.prepare(`SELECT 1 FROM portfolios WHERE id=? AND secret=?`).bind(pid,psec).all();
      if (!(okRow.results||[]).length) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, exposure FROM portfolio_factor_exposure WHERE portfolio_id=? ORDER BY as_of DESC, factor ASC LIMIT 700`).bind(pid).all();
      return json({ ok:true, rows: rs.results||[] });
    }

    // Run backtest
    if (url.pathname === '/admin/backtests' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const lookbackDays = Number(body.lookbackDays)||90;
  const txCostBps = Number(body.txCostBps)||0;
  const slippageBps = Number(body.slippageBps)||0;
  const out = await runBacktest(env, { lookbackDays, txCostBps, slippageBps });
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
        (async ()=> {
          const r = await fetch(new URL('/admin/integrity', url.origin).toString(), { headers: { 'x-admin-token': req.headers.get('x-admin-token')||'' }}).catch(()=>null);
          return r ? await r.json().catch(()=>({})) : {};
        })(),
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
  const out = await computeSignalsBulk(env, 365);
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
        return json(out);
      } catch (e:any) {
        log('admin_run_pipeline_error', { error: String(e) });
        return json({ ok:false, error:String(e) }, 500);
      }
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
  await detectAnomalies(env);
  await snapshotPortfolioNAV(env);
  await snapshotPortfolioFactorExposure(env);
  log('cron_run', bulk);
    } catch (e) {
  log('cron_error', { error: String(e) });
    }
  }
};
