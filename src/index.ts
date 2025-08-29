// src/index.ts
import { compositeScore } from './signal_math';

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL: string;
}

// ---------- Utils & CORS ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS }});
}
function isoDaysAgo(days: number): string {
  const ms = Date.now() - Math.max(0, days) * 86400000;
  return new Date(ms).toISOString().slice(0,10);
}
function ok<T>(x: T) { return x; }

// ---------- Universe fetch ----------
async function fetchUniverse(env: Env) {
  const rarities = [
    'Special illustration rare','Illustration rare','Ultra Rare',
    'Rare Secret','Rare Rainbow','Full Art','Promo'
  ];
  const q = encodeURIComponent(
    rarities.map(r => `rarity:"${r}"`).join(' OR ') + ' -set.series:"Japanese"'
  );
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.PTCG_API_KEY }, cf: { cacheTtl: 900 }});
  if (!res.ok) throw new Error(`PTCG ${res.status}`);
  const j = await res.json();
  return j.data ?? [];
}

async function upsertCards(env: Env, cards: any[]) {
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    batch.push(env.DB.prepare(`
      INSERT OR REPLACE INTO cards
      (id,name,set_id,set_name,number,rarity,image_url,tcgplayer_url,cardmarket_url)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      c.id, c.name, c.set?.id ?? null, c.set?.name ?? null, c.number ?? null,
      c.rarity ?? null, c.images?.small ?? null, c.tcgplayer?.url ?? null, c.cardmarket?.url ?? null
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

// ---------- Signals ----------
async function computeSignals(env: Env) {
  const today = new Date().toISOString().slice(0,10);

  // enumerate cards
  const cardsRs = await env.DB.prepare(`SELECT id FROM cards`).all();
  const ids = (cardsRs.results ?? []).map((r:any)=> r.id);

  let wrote = 0;
  for (const id of ids) {
    // price series (ASC)
    const px = await env.DB.prepare(`
      SELECT as_of, COALESCE(price_usd, price_eur) AS p
      FROM prices_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(id).all();

    // svi series (ASC)
    const svi = await env.DB.prepare(`
      SELECT as_of, svi FROM svi_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(id).all();

    const prices = (px.results ?? []).map((r:any)=> Number(r.p)).filter(Number.isFinite);
    const svis   = (svi.results ?? []).map((r:any)=> Number(r.svi)).filter((x:number)=> Number.isFinite(x));

    // NEW: allow SVI-only signals (>=14 SVI points) even if <7 prices
    if (prices.length < 7 && svis.length < 14) {
      continue;
    }

    const { score, signal, reasons, edgeZ, expRet, expSd, components } = compositeScore(prices, svis);

    await env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd).run();

    await env.DB.prepare(`
      INSERT OR REPLACE INTO signal_components_daily
      (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, today,
      components.ts7, components.ts30, components.dd, components.vol,
      components.zSVI, components.regimeBreak ? 1 : 0
    ).run();

    wrote++;
  }
  return wrote;
}

async function sendSignalChangeEmails(env: Env) {
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

  const body = (list: any[]) => `
  <h3>Signal changes today</h3>
  <ul>${list.map((r:any) => `<li><b>${r.name}</b> (${r.set_name}): ${r.prev_signal} → <b>${r.signal}</b></li>`).join('')}</ul>`;

  for (const s of subs.results as any[]) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'PokeQuant <onboarding@resend.dev>',
        to: [s.target],
        subject: 'PokeQuant — Signal changes',
        html: body(rows.results)
      })
    });
  }
}

// ---------- Admin helpers ----------
async function diag(env: Env) {
  const [
    svi14, p1, p7, sigLatest, maxP, maxSvi, maxSig
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM svi_daily GROUP BY card_id HAVING COUNT(*) >= 14)`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 1)`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 7)`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of = (SELECT MAX(as_of) FROM signals_daily)`).all(),
    env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
    env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
    env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all()
  ]);
  return {
    ok: true,
    cards_with_svi14_plus: svi14.results?.[0]?.n ?? 0,
    cards_with_price1_plus: p1.results?.[0]?.n ?? 0,
    cards_with_price7_plus: p7.results?.[0]?.n ?? 0,
    signals_rows_latest:   sigLatest.results?.[0]?.n ?? 0,
    latest_price_date:     maxP.results?.[0]?.d ?? null,
    latest_svi_date:       maxSvi.results?.[0]?.d ?? null,
    latest_signal_date:    maxSig.results?.[0]?.d ?? null
  };
}

// ---------- Pipeline orchestrator ----------
async function pipelineRun(env: Env) {
  const t0 = Date.now();

  let universe: any[] = [];
  let fetched = false;
  try {
    universe = await fetchUniverse(env);
    fetched = true;
  } catch (e) {
    // If PTCG fails (e.g., 504), log and continue (compute from DB data we already have)
    console.log('[pipeline] fetchUniverse failed, will continue with existing DB data:', String(e));
  }
  const t1 = Date.now();

  if (fetched && universe.length) {
    await upsertCards(env, universe);
    await snapshotPrices(env, universe);
  }
  const t2 = Date.now();

  const wrote = await computeSignals(env);
  const t3 = Date.now();

  await sendSignalChangeEmails(env);
  const t4 = Date.now();

  // alerts runner + digest (no-op if not configured)
  // (kept minimal for MVP — not shown to save space)

  const today = new Date().toISOString().slice(0,10);
  const [priceRows, signalRows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`).bind(today).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`).bind(today).all()
  ]);

  return {
    ok: true,
    cardCount: universe.length || (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all()).results?.[0]?.n || 0,
    pricesForToday: priceRows.results?.[0]?.n ?? 0,
    signalsForToday: signalRows.results?.[0]?.n ?? 0,
    timingsMs: { fetchUpsert: t1-t0, prices: t2-t1, signals: t3-t2, emails: t4-t3, total: t4-t0 }
  };
}

// ---------- HTTP handlers ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // Admin endpoints
    if (url.pathname === '/admin/diag' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      return json(await diag(env));
    }
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try {
        const out = await pipelineRun(env);
        return json(out);
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Public: cards w/ latest signals
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
        LIMIT 200
      `).all();
      return json(rs.results ?? []);
    }

    // Public: entire universe (fallback for UI & Trends bootstrap)
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

    // Ingest Trends (from GitHub Action)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      const payload = await req.json().catch(()=>({}));
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return json({ ok:true, rows: 0 });

      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`
          INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)
        `).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok: true, rows: rows.length });
    }

    // Health
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
        const [cards, prices, signals, svi, latestPrice, latestSignal, latestSVI] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM svi_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
        ]);
        return json({ ok:true, counts: {
          cards: cards.results?.[0]?.n ?? 0,
          prices_daily: prices.results?.[0]?.n ?? 0,
          signals_daily: signals.results?.[0]?.n ?? 0,
          svi_daily: svi.results?.[0]?.n ?? 0
        }, latest: {
          prices_daily: latestPrice.results?.[0]?.d ?? null,
          signals_daily: latestSignal.results?.[0]?.d ?? null,
          svi_daily: latestSVI.results?.[0]?.d ?? null
        }});
      } catch (err:any) {
        return json({ ok:false, error:String(err) }, 500);
      }
    }

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      const home = `PokeQuant API is running. See ${env.PUBLIC_BASE_URL || ''}/api/cards`;
      return new Response(home, { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    const result = await pipelineRun(env);
    console.log('[scheduled] cards=%d pricesToday=%d signalsToday=%d timings(ms)=%j',
      result.cardCount, result.pricesForToday, result.signalsForToday, result.timingsMs);
  }
};
