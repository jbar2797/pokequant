// src/index.ts
// PokeQuant Worker — restored search/filters + alerts, with existing APIs kept.
// IMPORTANT: run the DB migration in db_migration.sql before deploying this file
// so that 'cards' has types/supertype/subtypes columns.

import { compositeScore } from './signal_math';

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string;
}

// ---------- Utilities ----------
function isoDaysAgo(days: number): string {
  const ms = Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0,10);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...headers }
  });
}

// ---------- Core pipeline (unchanged behaviors) ----------
async function fetchUniverse(env: Env) {
  const rarities = [
    'Special illustration rare','Illustration rare','Ultra Rare',
    'Rare Secret','Rare Rainbow','Full Art','Promo'
  ];
  const q = encodeURIComponent(
    rarities.map(r => `rarity:"${r}"`).join(' OR ') + ' -set.series:"Japanese"'
  );
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.PTCG_API_KEY }});
  if (!res.ok) throw new Error(`PTCG ${res.status}`);
  const j = await res.json();
  return j.data ?? [];
}

async function upsertCards(env: Env, cards: any[]) {
  // Requires migration in db_migration.sql (adds types/supertype/subtypes columns)
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const types = Array.isArray(c.types) ? c.types.join(',') : (Array.isArray(c.types?.data) ? c.types.data.join(',') : null);
    const subtypes = Array.isArray(c.subtypes) ? c.subtypes.join(',') : null;
    const supertype = typeof c.supertype === 'string' ? c.supertype : null;
    batch.push(env.DB.prepare(`
      INSERT OR REPLACE INTO cards
      (id,name,set_id,set_name,number,rarity,image_url,tcgplayer_url,cardmarket_url,types,supertype,subtypes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      c.id, c.name, c.set?.id ?? null, c.set?.name ?? null, c.number ?? null,
      c.rarity ?? null, c.images?.small ?? null, c.tcgplayer?.url ?? null, c.cardmarket?.url ?? null,
      types, supertype, subtypes
    ));
  }
  if (batch.length) await env.DB.batch(batch);
}

async function snapshotPrices(env: Env, cards: any[]) {
  const today = new Date().toISOString().slice(0,10);
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const tp = c.tcgplayer, cm = c.cardmarket;
    const usd = tp?.prices ? (() => {
      const any = Object.values(tp.prices)[0] as any;
      return (any?.market ?? any?.mid ?? null);
    })() : null;
    const eur = cm?.prices?.trendPrice ?? cm?.prices?.avg7 ?? cm?.prices?.avg30 ?? null;
    batch.push(env.DB.prepare(`
      INSERT OR REPLACE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(c.id, today, usd, eur, tp?.updatedAt || cm?.updatedAt || null));
  }
  if (batch.length) await env.DB.batch(batch);
}

async function computeSignals(env: Env) {
  const today = new Date().toISOString().slice(0,10);
  const cards = await env.DB.prepare(`SELECT id FROM cards`).all();
  const latestSignalDate = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all();
  const lastD = latestSignalDate.results?.[0]?.d as string | null;

  // small batches to respect subrequest constraints
  const ids = (cards.results ?? []).map((r:any)=> r.id);
  const B = 50;
  for (let i=0;i<ids.length;i+=B) {
    const chunk = ids.slice(i,i+B);
    for (const id of chunk) {
      const px = await env.DB.prepare(`
        SELECT as_of, COALESCE(price_usd, price_eur) AS p
        FROM prices_daily WHERE card_id=? ORDER BY as_of ASC
      `).bind(id).all();
      const svi = await env.DB.prepare(`
        SELECT as_of, svi FROM svi_daily WHERE card_id=? ORDER BY as_of ASC
      `).bind(id).all();

      const prices = (px.results ?? []).map((r:any)=> Number(r.p)).filter((x)=> Number.isFinite(x));
      const svis   = (svi.results ?? []).map((r:any)=> Number(r.svi) || 0);
      if (prices.length < 7 && svis.length < 14) continue; // need min support

      const out = compositeScore(prices, svis);
      const { score, signal, reasons, edgeZ, expRet, expSd, components } = out;

      await env.DB.prepare(`
        INSERT OR REPLACE INTO signals_daily
        (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd).run();

      await env.DB.prepare(`
        INSERT OR REPLACE INTO signal_components_daily
        (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, today, components.ts7, components.ts30, components.dd, components.vol, components.zSVI, components.regimeBreak ? 1 : 0).run();
    }
  }
}

async function sendSignalChangeEmails(env: Env) {
  // unchanged logic kept intentionally simple for MVP
  const rows = await env.DB.prepare(`
    WITH sorted AS (
      SELECT card_id, signal, as_of,
             LAG(signal) OVER (PARTITION BY card_id ORDER BY as_of) AS prev_signal
      FROM signals_daily
    )
    SELECT s.card_id, s.signal, s.prev_signal, c.name, c.set_name
    FROM sorted s JOIN cards c ON c.id = s.card_id
    WHERE s.as_of = (SELECT MAX(as_of) FROM signals_daily)
      AND s.prev_signal IS NOT NULL AND s.signal <> s.prev_signal
  `).all();

  if (!rows.results?.length) return;
  const subs = await env.DB.prepare(`SELECT id, target FROM subscriptions WHERE kind='email'`).all();
  if (!subs.results?.length) return;

  const html = `<h3>Signal changes today</h3>
  <ul>${(rows.results as any[]).map(r => `<li><b>${r.name}</b> (${r.set_name}): ${r.prev_signal} → <b>${r.signal}</b></li>`).join('')}</ul>`;

  for (const s of subs.results as any[]) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PokeQuant <onboarding@resend.dev>',
        to: [s.target],
        subject: 'PokeQuant — Signal changes',
        html
      })
    });
  }
}

// Alerts: price_below / price_above
async function checkAlerts(env: Env) {
  const latestDate = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all();
  const asOf = latestDate.results?.[0]?.d as string | null;
  if (!asOf) return { checked: 0, fired: 0 };

  const rows = await env.DB.prepare(`
    SELECT id, email, kind, threshold, card_id, manage_token
    FROM alerts_watch WHERE active=1
  `).all();
  const list = (rows.results ?? []) as any[];
  if (!list.length) return { checked: 0, fired: 0 };

  let fired = 0;
  for (const a of list) {
    const p = await env.DB.prepare(`
      SELECT COALESCE(price_usd, price_eur) AS px
      FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1
    `).bind(a.card_id).all();
    const px = p.results?.[0]?.px as number | null;
    if (px == null) continue;
    let trigger = false;
    if (a.kind === 'price_below' && px <= a.threshold) trigger = true;
    if (a.kind === 'price_above' && px >= a.threshold) trigger = true;
    if (!trigger) continue;

    fired += 1;
    // notify user
    const url = env.PUBLIC_BASE_URL || 'https://example.com';
    const deactivateUrl = `${url}/alerts/deactivate?id=${encodeURIComponent(a.id)}&token=${encodeURIComponent(a.manage_token)}`;
    const html = `
      <p>Alert <b>${a.kind.replace('_',' ')}</b> fired for card <code>${a.card_id}</code>.</p>
      <p>Latest price: <b>${px}</b> vs threshold <b>${a.threshold}</b>.</p>
      <p><a href="${deactivateUrl}">Deactivate this alert</a></p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PokeQuant <onboarding@resend.dev>',
        to: [a.email],
        subject: `PokeQuant — Alert fired (${a.kind})`,
        html
      })
    });
    await env.DB.prepare(`UPDATE alerts_watch SET last_fired_at=? WHERE id=?`).bind(new Date().toISOString(), a.id).run();
  }
  return { checked: list.length, fired };
}

// One-shot pipeline
async function pipelineRun(env: Env) {
  const t0 = Date.now();
  let universe: any[] = [];
  try {
    universe = await fetchUniverse(env);
    await upsertCards(env, universe);
  } catch (_e) {
    // tolerate upstream hiccups; keep using existing cards
  }
  const t1 = Date.now();

  if (universe.length) await snapshotPrices(env, universe);
  const t2 = Date.now();

  await computeSignals(env);
  const t3 = Date.now();

  await sendSignalChangeEmails(env);
  const t4 = Date.now();

  const alerts = await checkAlerts(env);
  const t5 = Date.now();

  const today = new Date().toISOString().slice(0,10);
  const priceRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`
  ).bind(today).all();
  const signalRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`
  ).bind(today).all();
  const cardCountRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all();

  return {
    ok: true,
    cardCount: cardCountRes.results?.[0]?.n ?? 0,
    pricesForToday: priceRows.results?.[0]?.n ?? 0,
    signalsForToday: signalRows.results?.[0]?.n ?? 0,
    timingsMs: { fetchUpsert: t1-t0, prices: t2-t1, signals: t3-t2, emails: t4-t3, alerts: t5-t4, total: t5-t0 },
    alerts
  };
}

// ---------- HTTP ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // ---- Public discovery faceting ----
    if (url.pathname === '/api/sets' && req.method === 'GET') {
      const rs = await env.DB.prepare(`
        SELECT set_name AS v, COUNT(*) AS n
        FROM cards WHERE set_name IS NOT NULL AND set_name <> ''
        GROUP BY set_name ORDER BY n DESC, v ASC
      `).all();
      return json(rs.results ?? []);
    }
    if (url.pathname === '/api/rarities' && req.method === 'GET') {
      const rs = await env.DB.prepare(`
        SELECT rarity AS v, COUNT(*) AS n
        FROM cards WHERE rarity IS NOT NULL AND rarity <> ''
        GROUP BY rarity ORDER BY n DESC, v ASC
      `).all();
      return json(rs.results ?? []);
    }
    if (url.pathname === '/api/types' && req.method === 'GET') {
      // types is a comma-separated list we store in cards.types
      const rs = await env.DB.prepare(`SELECT types FROM cards WHERE types IS NOT NULL`).all();
      const set = new Set<string>();
      for (const r of (rs.results ?? []) as any[]) {
        const parts = (r.types ?? '').split(',').map((s:string)=> s.trim()).filter(Boolean);
        for (const p of parts) set.add(p);
      }
      const arr = Array.from(set).sort().map(v => ({ v }));
      return json(arr);
    }

    // ---- Search (q + filters) ----
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const set = (url.searchParams.get('set') || '').trim();
      const rarity = (url.searchParams.get('rarity') || '').trim();
      const type = (url.searchParams.get('type') || '').trim();
      let limit = parseInt(url.searchParams.get('limit') || '100', 10);
      let offset = parseInt(url.searchParams.get('offset') || '0', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 100;
      if (limit > 250) limit = 250;
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      const where: string[] = [];
      const args: any[] = [];

      if (q) {
        where.push(`(LOWER(c.name) LIKE ? OR LOWER(c.set_name) LIKE ? OR LOWER(c.id) LIKE ? OR LOWER(c.number) LIKE ?)`);
        const like = `%${q}%`;
        args.push(like, like, like, like);
      }
      if (set) { where.push(`c.set_name = ?`); args.push(set); }
      if (rarity) { where.push(`c.rarity = ?`); args.push(rarity); }
      if (type) {
        where.push(`(c.types LIKE ? OR c.subtypes LIKE ? OR c.supertype = ?)`);
        args.push(`%${type}%`, `%${type}%`, type);
      }

      const sql = `
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) as score,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_eur
        FROM cards c
        LEFT JOIN signals_daily s ON s.card_id=c.id
          AND s.as_of = (SELECT MAX(as_of) FROM signals_daily)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(s.score,0) DESC, c.name ASC
        LIMIT ? OFFSET ?
      `;
      args.push(limit, offset);
      const rs = await env.DB.prepare(sql).bind(...args).all();
      return json(rs.results ?? []);
    }

    // ---- Existing public surfaces ----
    if (url.pathname === '/api/movers' && req.method === 'GET') {
      let n = parseInt(url.searchParams.get('n') || '24', 10);
      if (!Number.isFinite(n) || n < 1) n = 24;
      if (n > 50) n = 50;
      const rs = await env.DB.prepare(`
        WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) AS score,
               sc.ts7, sc.z_svi,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_eur
        FROM cards c
        JOIN signals_daily s ON s.card_id=c.id
        JOIN signal_components_daily sc ON sc.card_id=c.id AND sc.as_of=s.as_of
        WHERE s.as_of = (SELECT d FROM latest)
        ORDER BY COALESCE(sc.ts7,0) DESC, s.score DESC
        LIMIT ?
      `).bind(n).all();
      return json(rs.results ?? []);
    }

    if (url.pathname === '/api/universe' && req.method === 'GET') {
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_eur
        FROM cards c
        ORDER BY c.set_name, c.name
        LIMIT 250
      `).all();
      return json(rs.results ?? []);
    }

    if (url.pathname === '/api/cards' && req.method === 'GET') {
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) as score,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_eur
        FROM cards c
        JOIN signals_daily s ON s.card_id=c.id
        WHERE s.as_of = (SELECT MAX(as_of) FROM signals_daily)
        ORDER BY s.score DESC
        LIMIT 250
      `).all();
      return json(rs.results ?? []);
    }

    // Detailed series
    if (url.pathname === '/api/card' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const meta = await env.DB.prepare(`
        SELECT id, name, set_name, rarity, image_url FROM cards WHERE id=? LIMIT 1
      `).bind(id).all();
      if (!meta.results?.length) return json({ error: 'unknown card_id' }, 404);

      const [pRs, sRs, gRs, cRs] = await Promise.all([
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi, regime_break FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
      ]);
      return json({ ok: true, card: meta.results[0], prices: pRs.results ?? [], svi: sRs.results ?? [], signals: gRs.results ?? [], components: cRs.results ?? [] });
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
      for (const r of (pRs.results ?? []) as any[]) map.set(r.d, { d: r.d, usd: r.usd ?? '', eur: r.eur ?? '' });
      for (const r of (sRs.results ?? []) as any[]) (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d)).svi = r.svi ?? '';
      for (const r of (gRs.results ?? []) as any[]) {
        const row = (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d));
        row.signal = r.signal ?? ''; row.score = r.score ?? '';
        row.edge_z = r.edge_z ?? ''; row.exp_ret = r.exp_ret ?? ''; row.exp_sd = r.exp_sd ?? '';
      }
      for (const r of (cRs.results ?? []) as any[]) {
        const row = (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d));
        row.ts7 = r.ts7 ?? ''; row.ts30 = r.ts30 ?? ''; row.dd = r.dd ?? ''; row.vol = r.vol ?? ''; row.z_svi = r.z_svi ?? '';
      }
      const dates = Array.from(map.keys()).sort();
      const header = ['date','price_usd','price_eur','svi','signal','score','edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'];
      const lines = [header.join(',')];
      for (const d of dates) {
        const r = map.get(d);
        lines.push([d, r.usd ?? '', r.eur ?? '', r.svi ?? '', r.signal ?? '', r.score ?? '', r.edge_z ?? '', r.exp_ret ?? '', r.exp_sd ?? '', r.ts7 ?? '', r.ts30 ?? '', r.dd ?? '', r.vol ?? '', r.z_svi ?? ''].join(','));
      }
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', ...CORS } });
    }

    // Subscribe
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email) return json({ error: 'email required' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT OR REPLACE INTO subscriptions (id,kind,target,created_at) VALUES (?,?,?,?)`)
        .bind(id, 'email', email, new Date().toISOString()).run();
      return json({ ok: true });
    }

    // Ingest (GH Action)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
      const payload = await req.json().catch(()=>({}));
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return json({ ok: true, rows: 0 });
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)`).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok: true, rows: rows.length });
    }

    // Health
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
        const [cards, prices1, signals1, svi1, latestPrice, latestSignal, latestSVI] = await Promise.all([
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
            prices_daily: prices1.results?.[0]?.n ?? 0,
            signals_daily: signals1.results?.[0]?.n ?? 0,
            svi_daily: svi1.results?.[0]?.n ?? 0
          },
          latest: {
            prices_daily: latestPrice.results?.[0]?.d ?? null,
            signals_daily: latestSignal.results?.[0]?.d ?? null,
            svi_daily: latestSVI.results?.[0]?.d ?? null
          }
        });
      } catch (err: any) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // ---- Alerts (public) ----
    if (url.pathname === '/alerts/create' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      const card_id = (body?.card_id ?? '').toString().trim();
      const kind = (body?.kind ?? 'price_below').toString().trim();
      const threshold = Number(body?.threshold);
      if (!email || !card_id) return json({ ok: false, error: 'email and card_id required' }, 400);
      if (!['price_below','price_above'].includes(kind)) return json({ ok: false, error: 'invalid kind' }, 400);
      if (!Number.isFinite(threshold)) return json({ ok: false, error: 'threshold required' }, 400);
      const id = crypto.randomUUID();
      const tokenBytes = new Uint8Array(16); crypto.getRandomValues(tokenBytes);
      const token = Array.from(tokenBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      await env.DB.prepare(`
        INSERT INTO alerts_watch (id,email,kind,threshold,card_id,active,created_at,manage_token)
        VALUES (?,?,?,?,?,1,?,?)
      `).bind(id, email, kind, threshold, card_id, new Date().toISOString(), token).run();
      return json({ ok: true, id, manage_token: token });
    }

    if (url.pathname === '/alerts/deactivate' && (req.method === 'GET' || req.method === 'POST')) {
      let id = ''; let token = '';
      if (req.method === 'GET') {
        const u = new URL(req.url);
        id = (u.searchParams.get('id') || '').trim();
        token = (u.searchParams.get('token') || '').trim();
      } else {
        const body = await req.json().catch(()=>({}));
        id = (body?.id || '').toString().trim();
        token = (body?.token || '').toString().trim();
      }
      if (!id || !token) return json({ ok: false, error: 'id and token required' }, 400);
      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=? AND manage_token=?`).bind(id, token).run();
      if (req.method === 'GET') {
        const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title>
      <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px">
        <h3>Alert deactivated.</h3>
        <p><a href="${env.PUBLIC_BASE_URL || '/'}">Back to PokeQuant</a></p>
      </body>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
      }
      return json({ ok: true });
    }

    // ---- Portfolio (unchanged) ----
    async function authPortfolio(req: Request) {
      const pid = req.headers.get('x-portfolio-id')?.trim();
      const sec = req.headers.get('x-portfolio-secret')?.trim();
      if (!pid || !sec) return { ok: false as const, status: 401, err: 'missing x-portfolio-id or x-portfolio-secret' };
      const row = await env.DB.prepare(`SELECT secret FROM portfolios WHERE id=?`).bind(pid).all();
      const stored = row.results?.[0]?.secret as string | undefined;
      if (!stored || stored !== sec) return { ok: false as const, status: 403, err: 'invalid portfolio credentials' };
      return { ok: true as const, portfolio_id: pid, secret: sec };
    }

    if (url.pathname === '/portfolio/create' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare(`INSERT INTO portfolios (id, secret, created_at) VALUES (?, ?, ?)`)
        .bind(id, secret, new Date().toISOString()).run();
      return json({ id, secret, note: 'Store these safely. They act as your login token.' });
    }

    if (url.pathname === '/portfolio/add-lot' && req.method === 'POST') {
      const auth = await authPortfolio(req); if (!auth.ok) return json({ error: auth.err }, auth.status);
      const body = await req.json().catch(()=>({}));
      const card_id = (body?.card_id ?? '').toString().trim();
      const qty = Number(body?.qty);
      const cost_usd = Number(body?.cost_usd);
      const acquired_at = (body?.acquired_at ?? new Date().toISOString().slice(0,10)).toString().trim();
      const note = (body?.note ?? '').toString().slice(0, 200);
      if (!card_id) return json({ error: 'card_id required' }, 400);
      if (!(qty > 0)) return json({ error: 'qty must be > 0' }, 400);
      if (!(cost_usd >= 0)) return json({ error: 'cost_usd must be >= 0' }, 400);
      const exists = await env.DB.prepare(`SELECT 1 FROM cards WHERE id=? LIMIT 1`).bind(card_id).all();
      if (!exists.results?.length) return json({ error: 'unknown card_id (not in cards table yet)' }, 400);

      const lot_id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO lots (id, portfolio_id, card_id, qty, cost_usd, acquired_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(lot_id, auth.portfolio_id, card_id, qty, cost_usd, acquired_at, note).run();
      return json({ ok: true, lot_id });
    }

    if (url.pathname === '/portfolio' && req.method === 'GET') {
      const auth = await authPortfolio(req); if (!auth.ok) return json({ error: auth.err }, auth.status);
      const lotsRes = await env.DB.prepare(`SELECT id, card_id, qty, cost_usd, acquired_at, note FROM lots WHERE portfolio_id=?`).bind(auth.portfolio_id).all();
      const lots = lotsRes.results ?? [];
      const byCard = new Map<string, { qty:number, cost_usd:number, lots:any[] }>();
      for (const l of lots as any[]) {
        const g = byCard.get(l.card_id) ?? { qty: 0, cost_usd: 0, lots: [] };
        g.qty += Number(l.qty) || 0; g.cost_usd += Number(l.cost_usd) || 0; g.lots.push(l);
        byCard.set(l.card_id, g);
      }
      const rows: any[] = [];
      for (const [card_id, agg] of byCard.entries()) {
        const meta = await env.DB.prepare(`SELECT name, set_name, image_url FROM cards WHERE id=?`).bind(card_id).all();
        const m = meta.results?.[0] ?? { name: card_id, set_name: '' , image_url: '' };
        const px = await env.DB.prepare(`SELECT price_usd, price_eur, as_of FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind(card_id).all();
        const p = px.results?.[0] ?? { price_usd: null, price_eur: null, as_of: null };
        const last_usd = (p.price_usd as number | null);
        const last_eur = (p.price_eur as number | null);
        const as_of = p.as_of as string | null;
        const market_value_usd = last_usd != null ? agg.qty * last_usd : null;
        const pnl_usd = (last_usd != null) ? (market_value_usd! - agg.cost_usd) : null;
        const roi_pct = (last_usd != null && agg.cost_usd > 0) ? (pnl_usd! / agg.cost_usd) * 100 : null;
        rows.push({
          card_id, name: m.name, set_name: m.set_name, image_url: m.image_url,
          qty: Number(agg.qty.toFixed(4)), cost_usd: Number(agg.cost_usd.toFixed(2)),
          price_usd: last_usd, price_eur: last_eur, price_as_of: as_of,
          market_value_usd: market_value_usd != null ? Number(market_value_usd.toFixed(2)) : null,
          pnl_usd: pnl_usd != null ? Number(pnl_usd.toFixed(2)) : null,
          roi_pct: roi_pct != null ? Number(roi_pct.toFixed(2)) : null
        });
      }
      const total_cost = rows.reduce((a,r)=> a + (r.cost_usd || 0), 0);
      const total_mkt  = rows.reduce((a,r)=> a + (r.market_value_usd || 0), 0);
      const total_pnl  = Number((total_mkt - total_cost).toFixed(2));
      const total_roi  = total_cost > 0 ? Number(((total_pnl/total_cost)*100).toFixed(2)) : null;
      return json({ ok: true, totals: {
        cost_usd: Number(total_cost.toFixed(2)),
        market_value_usd: Number(total_mkt.toFixed(2)),
        pnl_usd: total_pnl, roi_pct: total_roi
      }, rows });
    }

    if (url.pathname === '/portfolio/export' && req.method === 'GET') {
      const pid = req.headers.get('x-portfolio-id')?.trim();
      const sec = req.headers.get('x-portfolio-secret')?.trim();
      if (!pid || !sec) return json({ error: 'missing x-portfolio-id or x-portfolio-secret' }, 401);
      const row = await env.DB.prepare(`SELECT secret FROM portfolios WHERE id=?`).bind(pid).all();
      const stored = row.results?.[0]?.secret as string | undefined;
      if (!stored || stored !== sec) return json({ error: 'invalid portfolio credentials' }, 403);
      const lots = await env.DB.prepare(`SELECT id, card_id, qty, cost_usd, acquired_at, note FROM lots WHERE portfolio_id=? ORDER BY acquired_at ASC, id ASC`).bind(pid).all();
      return json({ ok: true, portfolio_id: pid, lots: lots.results ?? [] });
    }

    // ---- Admin ----
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const out = await pipelineRun(env);
      return json(out);
    }

    if (url.pathname === '/admin/run-alerts' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const out = await checkAlerts(env);
      return json({ ok: true, ...out });
    }

    if (url.pathname === '/admin/diag' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const diag = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
        env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM svi_daily GROUP BY card_id HAVING COUNT(*) >= 14 LIMIT 1`).all().catch(()=>({results:[{n:0}]})),
        env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 1 LIMIT 1`).all().catch(()=>({results:[{n:0}]})),
        env.DB.prepare(`SELECT COUNT(DISTINCT card_id) AS n FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 7 LIMIT 1`).all().catch(()=>({results:[{n:0}]})),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily)`).all().catch(()=>({results:[{n:0}]})),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
      ]);
      return json({
        ok: true,
        cards: diag[0].results?.[0]?.n ?? 0,
        cards_with_svi14_plus: diag[1].results?.[0]?.n ?? 0,
        cards_with_price1_plus: diag[2].results?.[0]?.n ?? 0,
        cards_with_price7_plus: diag[3].results?.[0]?.n ?? 0,
        signals_rows_latest: diag[4].results?.[0]?.n ?? 0,
        latest_price_date: diag[5].results?.[0]?.d ?? null,
        latest_svi_date: diag[6].results?.[0]?.d ?? null,
        latest_signal_date: diag[7].results?.[0]?.d ?? null
      });
    }

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    await pipelineRun(env);
  }
};