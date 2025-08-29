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

// Utility: ISO date string for N days ago
function isoDaysAgo(days: number): string {
  const ms = Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0,10);
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret',
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
    const svis   = (svi.results ?? []).map((r:any)=> Number(r.svi) || 0);

    // NEW: allow signals when prices >= 7, even if SVI < 7 (we fall back to svi=off internally)
    if (prices.length < 7) continue;

    const out = compositeScore(prices, svis);
    const { score, signal, reasons, edgeZ, expRet, expSd, components } = out;

    await env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(row.id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd).run();

    // NEW: store components for research/export
    await env.DB.prepare(`
      INSERT OR REPLACE INTO signal_components_daily
      (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.id, today,
      components.ts7, components.ts30, components.dd, components.vol,
      components.zSVI, components.regimeBreak ? 1 : 0
    ).run();
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

// --- Portfolio helpers (already added in Sprint 6) ---
async function authPortfolio(req: Request, env: Env) {
  const pid = req.headers.get('x-portfolio-id')?.trim();
  const sec = req.headers.get('x-portfolio-secret')?.trim();
  if (!pid || !sec) return { ok: false as const, status: 401, err: 'missing x-portfolio-id or x-portfolio-secret' };
  const row = await env.DB.prepare(`SELECT secret FROM portfolios WHERE id=?`).bind(pid).all();
  const stored = row.results?.[0]?.secret as string | undefined;
  if (!stored || stored !== sec) return { ok: false as const, status: 403, err: 'invalid portfolio credentials' };
  return { ok: true as const, portfolio_id: pid, secret: sec };
}

// ---------- HTTP handlers ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

        // Preflight for CORS
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // GET /api/card?id=<card_id>&days=120
    // Returns one card's meta + time series (prices, SVI, signals, components) for the last N days.
    if (url.pathname === '/api/card' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);

      if (!id) return json({ error: 'id required' }, 400);

      // Card metadata
      const metaRs = await env.DB.prepare(`
        SELECT id, name, set_name, rarity, image_url
        FROM cards WHERE id=? LIMIT 1
      `).bind(id).all();
      const card = metaRs.results?.[0];
      if (!card) return json({ error: 'unknown card_id' }, 404);

      // Series (ASC by date)
      const pricesRs = await env.DB.prepare(`
        SELECT as_of AS d, price_usd AS usd, price_eur AS eur
        FROM prices_daily
        WHERE card_id=? AND as_of >= ?
        ORDER BY as_of ASC
      `).bind(id, since).all();

      const sviRs = await env.DB.prepare(`
        SELECT as_of AS d, svi
        FROM svi_daily
        WHERE card_id=? AND as_of >= ?
        ORDER BY as_of ASC
      `).bind(id, since).all();

      const sigRs = await env.DB.prepare(`
        SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd
        FROM signals_daily
        WHERE card_id=? AND as_of >= ?
        ORDER BY as_of ASC
      `).bind(id, since).all();

      const compRs = await env.DB.prepare(`
        SELECT as_of AS d, ts7, ts30, dd, vol, z_svi, regime_break
        FROM signal_components_daily
        WHERE card_id=? AND as_of >= ?
        ORDER BY as_of ASC
      `).bind(id, since).all();

      return json({
        ok: true,
        card,
        prices: pricesRs.results ?? [],
        svi: sviRs.results ?? [],
        signals: sigRs.results ?? [],
        components: compRs.results ?? []
      });
    }

    // GET /research/card-csv?id=<card_id>&days=120
    // CSV columns: date, price_usd, price_eur, svi, signal, score, edge_z, exp_ret, exp_sd, ts7, ts30, dd, vol, z_svi
    if (url.pathname === '/research/card-csv' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      // Pull each series
      const [pRs, sRs, gRs, cRs, mRs] = await Promise.all([
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT name, set_name FROM cards WHERE id=?`).bind(id).all()
      ]);

      const prices = (pRs.results ?? []) as any[];
      const svi    = (sRs.results ?? []) as any[];
      const sig    = (gRs.results ?? []) as any[];
      const comp   = (cRs.results ?? []) as any[];

      // Index by date
      const map = new Map<string, any>();
      for (const r of prices) map.set(r.d, { d: r.d, usd: r.usd ?? '', eur: r.eur ?? '' });
      for (const r of svi)    (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d)).svi = r.svi ?? '';
      for (const r of sig) {
        const row = (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d));
        row.signal = r.signal ?? '';
        row.score  = r.score ?? '';
        row.edge_z = r.edge_z ?? '';
        row.exp_ret= r.exp_ret ?? '';
        row.exp_sd = r.exp_sd ?? '';
      }
      for (const r of comp) {
        const row = (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d));
        row.ts7  = r.ts7 ?? '';
        row.ts30 = r.ts30 ?? '';
        row.dd   = r.dd ?? '';
        row.vol  = r.vol ?? '';
        row.z_svi= r.z_svi ?? '';
      }

      const dates = Array.from(map.keys()).sort(); // ASC
      const header = ['date','price_usd','price_eur','svi','signal','score','edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'];
      const lines = [header.join(',')];
      for (const d of dates) {
        const r = map.get(d);
        lines.push([
          d, r.usd ?? '', r.eur ?? '', r.svi ?? '', r.signal ?? '', r.score ?? '',
          r.edge_z ?? '', r.exp_ret ?? '', r.exp_sd ?? '',
          r.ts7 ?? '', r.ts30 ?? '', r.dd ?? '', r.vol ?? '', r.z_svi ?? ''
        ].join(','));
      }

      const csv = lines.join('\n');
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${id}_last${days}d.csv"`,
          ...CORS
        }
      });
    }

    // Public: list cards WITH latest signals (may be empty on early days)
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

    // Public: list universe regardless of signals (bootstrap + UI fallback)
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

    // Subscribe to email alerts
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

    // Ingest SVI from GitHub Action
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
      const payload = await req.json().catch(()=>({}));
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return json({ ok: true, rows: 0 });
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(
          `INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)`
        ).bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok: true, rows: rows.length });
    }

    // Health
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
            cards: cards.results?.[0]?.n ?? 0,
            prices_daily: prices.results?.[0]?.n ?? 0,
            signals_daily: signals.results?.[0]?.n ?? 0,
            svi_daily: svi.results?.[0]?.n ?? 0
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

    // Admin: run the nightly pipeline now
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const out = await pipelineRun(env);
      return json({ ok: true, ...out });
    }

    // Admin: send a test email
    if (url.pathname === '/admin/test-email' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(()=>({}));
      const to = (body?.to ?? '').toString().trim();
      const targetList: string[] = to ? [to] : [];
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

    // NEW: Research export (CSV) — /research/export-signals?days=90
    if (url.pathname === '/research/export-signals' && req.method === 'GET') {
      const daysRaw = url.searchParams.get('days') ?? '90';
      let days = parseInt(daysRaw, 10);
      if (!Number.isFinite(days) || days < 7) days = 90;
      if (days > 365) days = 365;
      const since = `-${days} days`;

      const rs = await env.DB.prepare(`
        SELECT s.as_of, s.card_id, c.name, c.set_name, s.signal, ROUND(s.score,1) AS score,
               s.edge_z, s.exp_ret, s.exp_sd,
               sc.ts7, sc.ts30, sc.dd, sc.vol, sc.z_svi
        FROM signals_daily s
        JOIN cards c ON c.id = s.card_id
        LEFT JOIN signal_components_daily sc
          ON sc.card_id = s.card_id AND sc.as_of = s.as_of
        WHERE s.as_of >= date('now', ?)
        ORDER BY s.as_of ASC, s.card_id ASC
      `).bind(since).all();

      const rows = (rs.results ?? []) as any[];
      const header = [
        'as_of','card_id','name','set_name','signal','score',
        'edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'
      ];
      const csv = [
        header.join(','),
        ...rows.map(r => [
          r.as_of, r.card_id,
          (r.name ?? '').toString().replace(/,/g,' '),
          (r.set_name ?? '').toString().replace(/,/g,' '),
          r.signal ?? '',
          r.score ?? '',
          r.edge_z ?? '',
          r.exp_ret ?? '',
          r.exp_sd ?? '',
          r.ts7 ?? '',
          r.ts30 ?? '',
          r.dd ?? '',
          r.vol ?? '',
          r.z_svi ?? ''
        ].join(','))
      ].join('\n');

      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="signals_${days}d.csv"`,
          ...CORS
        }
      });
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