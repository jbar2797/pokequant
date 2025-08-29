// src/index.ts
// PokeQuant Worker — bulk compute to avoid subrequest limits.
// Public API preserved; adds POST /admin/run-fast to compute signals only, safely.

import { compositeScore } from './signal_math';

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
function isoDaysAgo(days: number) {
  const d = new Date(Date.now() - Math.max(0, days)*86400000);
  return d.toISOString().slice(0,10);
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
  const j = await res.json();
  return j.data ?? [];
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
      threshold REAL,
      active INTEGER DEFAULT 1,
      manage_token TEXT,
      created_at TEXT,
      last_fired_at TEXT
    );
  `).run();
}

async function runAlerts(env: Env) {
  await ensureAlertsTable(env);
  const rs = await env.DB.prepare(`
    SELECT a.id, a.email, a.card_id, a.kind, a.threshold,
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
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email) return json({ error: 'email required' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT OR REPLACE INTO subscriptions (id, kind, target, created_at) VALUES (?, 'email', ?, datetime('now'))`).bind(id, email).run();
      return json({ ok: true });
    }

    // Alerts create/deactivate
    if (url.pathname === '/alerts/create' && req.method === 'POST') {
      await ensureAlertsTable(env);
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      const card_id = (body?.card_id ?? '').toString().trim();
      const kind = (body?.kind ?? 'price_below').toString().trim();
      const threshold = Number(body?.threshold);
      if (!email || !card_id) return json({ error: 'email and card_id required' }, 400);
      if (!Number.isFinite(threshold)) return json({ error: 'threshold must be a number' }, 400);
      const id = crypto.randomUUID();
      const tokenBytes = new Uint8Array(16); crypto.getRandomValues(tokenBytes);
      const manage_token = Array.from(tokenBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      await env.DB.prepare(`
        INSERT INTO alerts_watch (id,email,card_id,kind,threshold,active,manage_token,created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
      `).bind(id, email, card_id, kind, threshold, manage_token).run();
      const manage_url = `${env.PUBLIC_BASE_URL || ''}/alerts/deactivate?id=${encodeURIComponent(id)}&token=${encodeURIComponent(manage_token)}`;
      return json({ ok: true, id, manage_token, manage_url });
    }
    if (url.pathname === '/alerts/deactivate' && (req.method === 'GET' || req.method === 'POST')) {
      const id = req.method === 'GET' ? (url.searchParams.get('id') || '').trim() : ((await req.json().catch(()=>({})))?.id || '').toString().trim();
      const token = req.method === 'GET' ? (url.searchParams.get('token') || '').trim() : ((await req.json().catch(()=>({})))?.token || '').toString().trim();
      if (!id || !token) return json({ error: 'id and token required' }, 400);
      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
      const mt = row.results?.[0]?.manage_token as string | undefined;
      if (!mt || mt !== token) return json({ error: 'invalid token' }, 403);
      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
      if (req.method === 'GET') {
        const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px">
          <h3>Alert deactivated.</h3>
          <p><a href="${env.PUBLIC_BASE_URL || '/'}">Back to PokeQuant</a></p>
        </body>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS }});
      }
      return json({ ok: true });
    }

    // Ingest Trends (GitHub Action)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(()=>({}));
      const rows = Array.isArray(body?.rows) ? body.rows : [];
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

    // NEW: fast, bulk compute only (safe warm)
    if (url.pathname === '/admin/run-fast' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        const out = await computeSignalsBulk(env, 365);
        return json({ ok: true, ...out });
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Full pipeline (may hit subrequest caps if upstream is slow)
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try { return json(await pipelineRun(env)); }
      catch (e:any) { return json({ ok:false, error:String(e) }, 500); }
    }

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    try {
      await computeSignalsBulk(env, 365);
      await runAlerts(env);
    } catch (e) {
      console.log('scheduled error', String(e));
    }
  }
};
