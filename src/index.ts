// src/index.ts
import { compositeScore } from './signal_math';

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
}

/** Fetch a curated universe: high-interest rarities (English). */
async function fetchUniverse(env: Env) {
  const rarities = [
    'Special illustration rare', 'Illustration rare', 'Ultra Rare',
    'Rare Secret', 'Rare Rainbow', 'Full Art', 'Promo'
  ];
  const q = encodeURIComponent(rarities.map(r => `rarity:"${r}"`).join(' OR ') + ' -set.series:"Japanese"');
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.PTCG_API_KEY }});
  if (!res.ok) throw new Error(`PTCG ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

/** Upsert card metadata into D1. */
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

/** Snapshot prices once per day to build our own history. */
async function snapshotPrices(env: Env, cards: any[]) {
  const today = new Date().toISOString().slice(0,10);
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const tp = c.tcgplayer, cm = c.cardmarket;
    const usd = tp?.prices ? (() => {
      const any = Object.values(tp.prices)[0] as any; // take first available type
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

/** Compute signals from history + SVI and store them for today. */
async function computeSignals(env: Env) {
  const today = new Date().toISOString().slice(0,10);
  const cards = await env.DB.prepare(`SELECT id FROM cards`).all();

  for (const row of (cards.results ?? []) as any[]) {
    const px = await env.DB.prepare(`
      SELECT as_of, COALESCE(price_usd, price_eur) AS p
      FROM prices_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(row.id).all();

    const svi = await env.DB.prepare(`
      SELECT as_of, svi FROM svi_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(row.id).all();

    const prices = (px.results ?? []).map((r:any)=> r.p).filter((x:any)=> typeof x === 'number');
    const svis   = (svi.results ?? []).map((r:any)=> r.svi ?? 0);

    if (prices.length < 7 || svis.length < 7) continue;

    const { score, signal, reasons, edgeZ, expRet, expSd } = compositeScore(prices, svis);

    await env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(row.id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd).run();
  }
}

/** Email anyone subscribed whenever a card's signal changes vs yesterday. */
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
  <ul>${list.map(r => `<li><b>${r.name}</b> (${r.set_name}): ${r.prev_signal} → <b>${r.signal}</b></li>`).join('')}</ul>`;

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

export default {
  /** Tiny JSON API + ingest endpoint */
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // Top cards with latest signals
    if (url.pathname === '/api/cards') {
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) as score,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) as price_eur
        FROM cards c
        LEFT JOIN signals_daily s ON s.card_id=c.id
        WHERE s.as_of = (SELECT MAX(as_of) FROM signals_daily)
        ORDER BY s.score DESC
        LIMIT 200
      `).all();
      return new Response(JSON.stringify(rs.results ?? []), { headers: {'content-type':'application/json'}});
    }

    // Subscribe to email alerts
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email) return new Response('email required', { status: 400 });
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR REPLACE INTO subscriptions (id,kind,target,created_at)
        VALUES (?,?,?,?)
      `).bind(id, 'email', email, new Date().toISOString()).run();
      return new Response(JSON.stringify({ ok: true }), { headers: {'content-type':'application/json'}});
    }

    // GitHub Action posts SVI here
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const payload = await req.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return new Response(JSON.stringify({ok:true, rows:0}), { headers: {'content-type':'application/json'}});
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`
          INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)
        `).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return new Response(JSON.stringify({ ok: true, rows: rows.length }), { headers: {'content-type':'application/json'}});
    }

    // Minimal root response
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: {'content-type':'text/plain'}});
    }

    return new Response('Not found', { status: 404 });
  },

  /** Nightly job: ingest universe + prices, compute signals, and notify */
  async scheduled(_ev: ScheduledEvent, env: Env) {
    const universe = await fetchUniverse(env);
    await upsertCards(env, universe);
    await snapshotPrices(env, universe);
    await computeSignals(env);
    await sendSignalChangeEmails(env);
  }
}
