// src/index.ts
import { compositeScore } from './signal_math';

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
}

// ---------- CORS helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-token, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS }
  });
}

// ---------- Core pipeline steps ----------
async function fetchUniverse(env: Env) {
  // Curated rarities; exclude Japanese to reduce variant noise for MVP
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
  const json = await res.json();
  return json.data ?? [];
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

async function authPortfolio(req: Request, env: Env) {
  const pid = req.headers.get('x-portfolio-id')?.trim();
  const sec = req.headers.get('x-portfolio-secret')?.trim();
  if (!pid || !sec) {
    return { ok: false as const, status: 401, err: 'missing x-portfolio-id or x-portfolio-secret' };
  }
  const row = await env.DB.prepare(`SELECT secret FROM portfolios WHERE id=?`).bind(pid).all();
  const stored = row.results?.[0]?.secret as string | undefined;
  if (!stored || stored !== sec) {
    return { ok: false as const, status: 403, err: 'invalid portfolio credentials' };
  }
  return { ok: true as const, portfolio_id: pid, secret: sec };
}


// One-shot pipeline to reuse in cron and admin/run-now
async function pipelineRun(env: Env) {
  const t0 = Date.now();
  const universe = await fetchUniverse(env);
  await upsertCards(env, universe);
  const t1 = Date.now();

  await snapshotPrices(env, universe);
  const t2 = Date.now();

  await computeSignals(env);
  const t3 = Date.now();

  await sendSignalChangeEmails(env);
  const t4 = Date.now();

  // Quick stats
  const today = new Date().toISOString().slice(0,10);
  const cardCount = universe.length;
  const priceRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`
  ).bind(today).all();
  const signalRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`
  ).bind(today).all();

  return {
    cardCount,
    pricesForToday: priceRows.results?.[0]?.n ?? 0,
    signalsForToday: signalRows.results?.[0]?.n ?? 0,
    timingsMs: { fetchUpsert: t1-t0, prices: t2-t1, signals: t3-t2, emails: t4-t3, total: t4-t0 }
  };
}

// ---------- HTTP handlers ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // Preflight for CORS
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // List universe of cards regardless of signals (for Trends bootstrap + UI fallback)
    if (url.pathname === '/api/universe' && req.method === 'GET') {
      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
              (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
              (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        ORDER BY c.set_name, c.name
        LIMIT 250
      `).all();
      return json(rs.results ?? []);
    }

    // Create a new portfolio (returns id + secret)
    // Client must store both; the secret is shown once.
    if (url.pathname === '/portfolio/create' && req.method === 'POST') {
      const id = crypto.randomUUID();
      // random 16-byte hex secret
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare(`
        INSERT INTO portfolios (id, secret, created_at) VALUES (?, ?, ?)
      `).bind(id, secret, new Date().toISOString()).run();
      return json({ id, secret, note: 'Store these safely. They act as your login token.' });
    }

    // Add a lot to a portfolio
    // headers: x-portfolio-id, x-portfolio-secret
    // body: { card_id, qty, cost_usd, acquired_at?, note? }
    if (url.pathname === '/portfolio/add-lot' && req.method === 'POST') {
      const auth = await authPortfolio(req, env);
      if (!auth.ok) return json({ error: auth.err }, auth.status);

      const body = await req.json().catch(()=>({}));
      const card_id = (body?.card_id ?? '').toString().trim();
      const qty = Number(body?.qty);
      const cost_usd = Number(body?.cost_usd);
      const acquired_at = (body?.acquired_at ?? new Date().toISOString().slice(0,10)).toString().trim();
      const note = (body?.note ?? '').toString().slice(0, 200);

      if (!card_id) return json({ error: 'card_id required' }, 400);
      if (!(qty > 0)) return json({ error: 'qty must be > 0' }, 400);
      if (!(cost_usd >= 0)) return json({ error: 'cost_usd must be >= 0' }, 400);

      // Verify card exists in our DB to avoid typos
      const exists = await env.DB.prepare(`SELECT 1 FROM cards WHERE id=? LIMIT 1`).bind(card_id).all();
      if (!exists.results?.length) return json({ error: 'unknown card_id (not in cards table yet)' }, 400);

      const lot_id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO lots (id, portfolio_id, card_id, qty, cost_usd, acquired_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(lot_id, auth.portfolio_id, card_id, qty, cost_usd, acquired_at, note).run();

      return json({ ok: true, lot_id });
    }

      // Get portfolio P&L summary and positions
      // headers: x-portfolio-id, x-portfolio-secret
      if (url.pathname === '/portfolio' && req.method === 'GET') {
        const auth = await authPortfolio(req, env);
        if (!auth.ok) return json({ error: auth.err }, auth.status);

        // Pull all lots for this portfolio
        const lotsRes = await env.DB.prepare(`
          SELECT id, card_id, qty, cost_usd, acquired_at, note
          FROM lots WHERE portfolio_id=?
        `).bind(auth.portfolio_id).all();
        const lots = lotsRes.results ?? [];

        // Group by card_id
        const byCard = new Map<string, { qty:number, cost_usd:number, lots:any[] }>();
        for (const l of lots) {
          const k = l.card_id;
          const g = byCard.get(k) ?? { qty: 0, cost_usd: 0, lots: [] };
          g.qty += Number(l.qty) || 0;
          g.cost_usd += Number(l.cost_usd) || 0;
          g.lots.push(l);
          byCard.set(k, g);
        }

        // For each card, fetch latest price and card meta
        const rows: any[] = [];
        for (const [card_id, agg] of byCard.entries()) {
          const meta = await env.DB.prepare(`SELECT name, set_name, image_url FROM cards WHERE id=?`).bind(card_id).all();
          const m = meta.results?.[0] ?? { name: card_id, set_name: '' , image_url: '' };

          const px = await env.DB.prepare(`
            SELECT price_usd, price_eur, as_of
            FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1
          `).bind(card_id).all();
          const p = px.results?.[0] ?? { price_usd: null, price_eur: null, as_of: null };

          // Prefer USD; if missing, we still report EUR (but P&L uses USD only)
          const last_usd = (p.price_usd as number | null);
          const last_eur = (p.price_eur as number | null);
          const as_of = p.as_of as string | null;

          const market_value_usd = last_usd != null ? agg.qty * last_usd : null;
          const pnl_usd = (last_usd != null) ? (market_value_usd! - agg.cost_usd) : null;
          const roi_pct = (last_usd != null && agg.cost_usd > 0) ? (pnl_usd! / agg.cost_usd) * 100 : null;

          rows.push({
            card_id,
            name: m.name,
            set_name: m.set_name,
            image_url: m.image_url,
            qty: Number(agg.qty.toFixed(4)),
            cost_usd: Number(agg.cost_usd.toFixed(2)),
            price_usd: last_usd,
            price_eur: last_eur,     // for display only if USD missing
            price_as_of: as_of,
            market_value_usd: market_value_usd != null ? Number(market_value_usd.toFixed(2)) : null,
            pnl_usd: pnl_usd != null ? Number(pnl_usd.toFixed(2)) : null,
            roi_pct: roi_pct != null ? Number(roi_pct.toFixed(2)) : null
          });
        }

        // Totals
        const total_cost = rows.reduce((a,r)=> a + (r.cost_usd || 0), 0);
        const total_mkt  = rows.reduce((a,r)=> a + (r.market_value_usd || 0), 0);
        const total_pnl  = Number((total_mkt - total_cost).toFixed(2));
        const total_roi  = total_cost > 0 ? Number(((total_pnl/total_cost)*100).toFixed(2)) : null;

        return json({ ok: true, totals: {
          cost_usd: Number(total_cost.toFixed(2)),
          market_value_usd: Number(total_mkt.toFixed(2)),
          pnl_usd: total_pnl,
          roi_pct: total_roi
        }, rows });
      }

      // Export lots (backup)
      // headers: x-portfolio-id, x-portfolio-secret
      if (url.pathname === '/portfolio/export' && req.method === 'GET') {
        const auth = await authPortfolio(req, env);
        if (!auth.ok) return json({ error: auth.err }, auth.status);

        const lots = await env.DB.prepare(`
          SELECT id, card_id, qty, cost_usd, acquired_at, note
          FROM lots WHERE portfolio_id=? ORDER BY acquired_at ASC, id ASC
        `).bind(auth.portfolio_id).all();

        return json({ ok: true, portfolio_id: auth.portfolio_id, lots: lots.results ?? [] });
      }

    // Public API: list cards with latest signals
    if (url.pathname === '/api/cards' && req.method === 'GET') {
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
      return json(rs.results ?? []);
    }

    // Public API: subscribe to emails
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email) return json({ error: 'email required' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR REPLACE INTO subscriptions (id,kind,target,created_at)
        VALUES (?,?,?,?)
      `).bind(id, 'email', email, new Date().toISOString()).run();
      return json({ ok: true });
    }

    // Ingest endpoint for GitHub Action (Google Trends SVI)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) {
        return json({ error: 'forbidden' }, 403);
      }
      const payload = await req.json().catch(()=>({}));
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return json({ ok: true, rows: 0 });
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`
          INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)
        `).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok: true, rows: rows.length });
    }

    // NEW: Health check (counts + latest dates)
    if (url.pathname === '/health' && req.method === 'GET') {
    try {
      const [
        cards, prices, signals, svi,
        latestPrice, latestSignal, latestSVI
      ] = await Promise.all([
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
          cards:         cards.results?.[0]?.n ?? 0,
          prices_daily:  prices.results?.[0]?.n ?? 0,
          signals_daily: signals.results?.[0]?.n ?? 0,
          svi_daily:     svi.results?.[0]?.n ?? 0
        },
        latest: {
          prices_daily:  latestPrice.results?.[0]?.d ?? null,
          signals_daily: latestSignal.results?.[0]?.d ?? null,
          svi_daily:     latestSVI.results?.[0]?.d ?? null
        }
      });
    } catch (err: any) {
      // If anything goes wrong (e.g., DB not bound), we still return JSON.
      return json({ ok: false, error: String(err) }, 500);
    }
  }


    // NEW: Admin: run the nightly pipeline now
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ error: 'forbidden' }, 403);
      }
      const out = await pipelineRun(env);
      return json({ ok: true, ...out });
    }

    // NEW: Admin: send a test email
    if (url.pathname === '/admin/test-email' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ error: 'forbidden' }, 403);
      }
      const body = await req.json().catch(()=>({}));
      const to = (body?.to ?? '').toString().trim();
      const targetList: string[] = to ? [to] : [];
      // If no 'to' provided, try first subscriber:
      if (!to) {
        const s = await env.DB.prepare(`SELECT target FROM subscriptions WHERE kind='email' LIMIT 1`).all();
        const first = s.results?.[0]?.target;
        if (first) targetList.push(first);
      }
      if (!targetList.length) return json({ error: 'no recipient found (pass {"to":"you@example.com"})' }, 400);

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'PokeQuant <onboarding@resend.dev>',
          to: targetList,
          subject: 'PokeQuant — Test email',
          html: `<p>This is a test email from PokeQuant admin.</p>`
        })
      });
      return json({ ok: res.ok });
    }

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  // Nightly cron: run full pipeline
  async scheduled(_ev: ScheduledEvent, env: Env) {
    const result = await pipelineRun(env);
    console.log('[scheduled] cards=%d pricesToday=%d signalsToday=%d timings(ms)=%j',
      result.cardCount, result.pricesForToday, result.signalsForToday, result.timingsMs);
  }
};
