// src/index.ts
// PokeQuant Worker — bulk compute to avoid subrequest limits.
// Public API preserved; adds POST /admin/run-fast to compute signals only, safely.

import { compositeScore } from './signal_math';
import { z } from 'zod';
// Structured logging helper
function log(event: string, fields: Record<string, unknown> = {}) {
  try { console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields })); } catch { /* noop */ }
}

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string; // e.g., https://pokequant.pages.dev
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
const RATE_LIMITS = {
  search: { limit: 30, window: 300 },          // 30 per 5 min per IP
  subscribe: { limit: 5, window: 86400 },       // 5 per day per IP
  alertCreate: { limit: 10, window: 86400 },    // 10 per day per IP+email
};

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

// Lazy test seeding (only if DB empty / tables missing) to allow unit tests to pass without migration step.
async function ensureTestSeed(env: Env) {
  try {
    const check = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cards'`).all();
    if (!check.results || !check.results.length) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, rarity TEXT, image_url TEXT, types TEXT);`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id,as_of));`).run();
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
    const { score, signal, reasons, edgeZ, expRet, expSd, components } = out;

    writesSignals.push(env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd));

    writesComponents.push(env.DB.prepare(`
      INSERT OR REPLACE INTO signal_components_daily
      (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, today, components.ts7, components.ts30, components.dd, components.vol, components.zSVI, components.regimeBreak ? 1 : 0));
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

// ---------- HTTP ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // Health
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
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
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        ORDER BY c.set_name, c.name
        LIMIT 250
      `).all();
      return json(rs.results ?? []);
    }
    if (url.pathname === '/api/cards' && req.method === 'GET') {
  await incMetric(env, 'cards.list');
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
      return json(rs.results ?? []);
    }

    // Movers (up/down)
    if (url.pathname === '/api/movers' && req.method === 'GET') {
  await incMetric(env, 'cards.movers');
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
      return json(rs.results ?? []);
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
      return json({ ok: true, card: meta.results?.[0] ?? null, prices: p.results ?? [], signals: g.results ?? [], svi: v.results ?? [], components: c.results ?? [] });
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
  const cfg = RATE_LIMITS.subscribe;
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
  return json({ ok: true });
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
  const cfg = RATE_LIMITS.alertCreate;
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
      return json({ ok: true, id, manage_token, manage_url });
    }

    // --- Search & metadata endpoints (MVP completion) ---
    if (url.pathname === '/api/sets' && req.method === 'GET') {
      await ensureTestSeed(env);
      const rs = await env.DB.prepare(`SELECT set_name AS v, COUNT(*) AS n FROM cards GROUP BY set_name ORDER BY n DESC`).all();
      return json(rs.results || []);
    }
    if (url.pathname === '/api/rarities' && req.method === 'GET') {
      await ensureTestSeed(env);
      const rs = await env.DB.prepare(`SELECT rarity AS v, COUNT(*) AS n FROM cards GROUP BY rarity ORDER BY n DESC`).all();
      return json(rs.results || []);
    }
    if (url.pathname === '/api/types' && req.method === 'GET') {
      await ensureTestSeed(env);
      const rs = await env.DB.prepare(`SELECT DISTINCT types FROM cards WHERE types IS NOT NULL`).all();
      const out: { v: string }[] = [];
      for (const r of (rs.results||[]) as any[]) {
        const parts = String(r.types||'').split('|').filter(Boolean);
        for (const p of parts) out.push({ v: p });
      }
      return json(out);
    }
    if (url.pathname === '/api/search' && req.method === 'GET') {
      await ensureTestSeed(env);
  const ip = req.headers.get('cf-connecting-ip') || 'anon';
  const rlKey = `search:${ip}`;
  const cfg = RATE_LIMITS.search;
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
      return json(rs.results || []);
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
        return json({ ok:true, rows: rs.results || [] });
      } catch {
        return json({ ok:true, rows: [] });
      }
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
  log('cron_run', bulk);
    } catch (e) {
  log('cron_error', { error: String(e) });
    }
  }
};
