// src/index.ts
import { compositeScore } from './signal_math';

export interface Env {
  DB: D1Database;
  PTCG_API_KEY: string;
  RESEND_API_KEY: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  PUBLIC_BASE_URL?: string;
}

// ---------- CORS + helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS }
  });
}
function isoDaysAgo(days: number): string {
  const ms = Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0,10);
}
function isValidEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function baseUrl(env: Env) {
  return env.PUBLIC_BASE_URL || 'https://pokequant.jonathanbarreneche.workers.dev';
}
async function sendEmail(env: Env, to: string | string[], subject: string, html: string) {
  const list = Array.isArray(to) ? to : [to];
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'PokeQuant <onboarding@resend.dev>', to: list, subject, html })
  });
}

// ---------- Core pipeline ----------
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

    if (prices.length < 7) continue;

    const out = compositeScore(prices, svis);
    const { score, signal, reasons, edgeZ, expRet, expSd, components } = out;

    await env.DB.prepare(`
      INSERT OR REPLACE INTO signals_daily
      (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(row.id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd).run();

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

  const subs = await env.DB.prepare(`SELECT target FROM subscriptions WHERE kind='email'`).all();
  if (!subs.results?.length) return;

  const html = (list: any[]) => `
    <h3>Signal changes today</h3>
    <ul>${list.map(r => `<li><b>${r.name}</b> (${r.set_name}): ${r.prev_signal} → <b>${r.signal}</b></li>`).join('')}</ul>`;
  for (const s of subs.results as any[]) {
    await sendEmail(env, s.target, 'PokeQuant — Signal changes', html(rows.results));
  }
}

// ---------- Watchlist alerts ----------
async function runAlerts(env: Env) {
  const alerts = await env.DB.prepare(`
    SELECT a.id, a.email, a.card_id, a.kind, a.threshold_usd, a.last_fired_at,
           c.name, c.set_name
    FROM alerts_watch a
    JOIN cards c ON c.id = a.card_id
    WHERE a.active = 1
  `).all();

  if (!alerts.results?.length) return { checked: 0, fired: 0 };

  let fired = 0;
  for (const a of alerts.results as any[]) {
    const px = await env.DB.prepare(`
      SELECT price_usd, as_of
      FROM prices_daily
      WHERE card_id=? ORDER BY as_of DESC LIMIT 1
    `).bind(a.card_id).all();
    const row = px.results?.[0];
    const lastAsOf = row?.as_of as string | undefined;
    const pUSD = row?.price_usd as number | null | undefined;

    if (pUSD == null || !lastAsOf) continue;

    const should = (a.kind === 'price_above')
      ? (pUSD >= a.threshold_usd)
      : (pUSD <= a.threshold_usd);

    if (should && a.last_fired_at !== lastAsOf) {
      // fetch manage token for one-click link
      const tokRow = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(a.id).all();
      const manage = tokRow.results?.[0]?.manage_token as string | undefined;

      const url = baseUrl(env);
      const linkHtml = manage
        ? `<p>Manage: <a href="${url}/alerts/deactivate?id=${a.id}&token=${manage}">Deactivate this alert</a></p>`
        : '';

      const subj = `PokeQuant alert: ${a.name} ${a.kind === 'price_above' ? '≥' : '≤'} $${a.threshold_usd.toFixed(2)} (now $${pUSD.toFixed(2)})`;
      const html = `
        <p><b>${a.name}</b> (${a.set_name})</p>
        <p>Latest price: <b>$${pUSD.toFixed(2)}</b> on ${lastAsOf}</p>
        <p>Alert condition: <code>${a.kind}</code> @ $${a.threshold_usd.toFixed(2)}</p>
        ${linkHtml}
      `;
      await sendEmail(env, a.email, subj, html);
      await env.DB.prepare(`UPDATE alerts_watch SET last_fired_at=? WHERE id=?`).bind(lastAsOf, a.id).run();
      fired++;
    }
  }
  return { checked: alerts.results.length, fired };
}

// ---------- One-shot nightly pipeline ----------
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

  const alertsOut = await runAlerts(env);
  const t5 = Date.now();

  const today = new Date().toISOString().slice(0,10);
  const priceRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`
  ).bind(today).all();
  const signalRows = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`
  ).bind(today).all();

  return {
    cardCount: universe.length,
    pricesForToday: priceRows.results?.[0]?.n ?? 0,
    signalsForToday: signalRows.results?.[0]?.n ?? 0,
    timingsMs: {
      fetchUpsert: t1-t0, prices: t2-t1, signals: t3-t2, emails: t4-t3, alerts: t5-t4, total: t5-t0
    },
    alerts: alertsOut
  };
}

// ---------- Portfolio auth ----------
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

    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // ----- Card details & research -----
    if (url.pathname === '/api/card' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const metaRs = await env.DB.prepare(`
        SELECT id, name, set_name, rarity, image_url
        FROM cards WHERE id=? LIMIT 1
      `).bind(id).all();
      const card = metaRs.results?.[0];
      if (!card) return json({ error: 'unknown card_id' }, 404);

      const [pricesRs, sviRs, sigRs, compRs] = await Promise.all([
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of >= ? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of >= ? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of >= ? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi, regime_break FROM signal_components_daily WHERE card_id=? AND as_of >= ? ORDER BY as_of ASC`).bind(id, since).all()
      ]);

      return json({
        ok: true,
        card,
        prices: pricesRs.results ?? [],
        svi: sviRs.results ?? [],
        signals: sigRs.results ?? [],
        components: compRs.results ?? []
      });
    }

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
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all()
      ]);

      const prices = (pRs.results ?? []) as any[];
      const svi    = (sRs.results ?? []) as any[];
      const sig    = (gRs.results ?? []) as any[];
      const comp   = (cRs.results ?? []) as any[];

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

      const dates = Array.from(map.keys()).sort();
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

    if (url.pathname === '/research/export-signals' && req.method === 'GET') {
      const raw = url.searchParams.get('days') ?? '90';
      let days = parseInt(raw, 10);
      if (!Number.isFinite(days) || days < 7) days = 90;
      if (days > 365) days = 365;
      const sinceExpr = `-${days} days`;

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
      `).bind(sinceExpr).all();

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
          r.signal ?? '', r.score ?? '', r.edge_z ?? '', r.exp_ret ?? '', r.exp_sd ?? '',
          r.ts7 ?? '', r.ts30 ?? '', r.dd ?? '', r.vol ?? '', r.z_svi ?? ''
        ].join(','))
      ].join('\n');

      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="signals_${days}d.csv"`, ...CORS }});
    }

    // ----- NEW: Top movers (24h delta using last vs previous day) -----
    if (url.pathname === '/api/top-movers' && req.method === 'GET') {
      // how many in each bucket (gainers/losers); default 6
      let limit = parseInt(url.searchParams.get('limit') || '6', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 6;
      if (limit > 20) limit = 20; // simple guard

      // latest date across all prices (for info)
      const maxRs = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all();
      const as_of = maxRs.results?.[0]?.d ?? null;

      // We use window functions to get rn=1 (latest) and rn=2 (previous) per card.
      const gainers = await env.DB.prepare(`
        WITH r AS (
          SELECT p.card_id, c.name, c.set_name, c.image_url,
                 COALESCE(p.price_usd, p.price_eur) AS price,
                 p.as_of,
                 ROW_NUMBER() OVER (PARTITION BY p.card_id ORDER BY p.as_of DESC) AS rn
          FROM prices_daily p
          JOIN cards c ON c.id = p.card_id
        ),
        l AS (SELECT * FROM r WHERE rn=1),
        prev AS (SELECT * FROM r WHERE rn=2)
        SELECT l.card_id, l.name, l.set_name, l.image_url,
               l.price AS price_now, prev.price AS price_prev,
               ROUND( ( (l.price - prev.price) / prev.price ) * 100.0, 2 ) AS pct
        FROM l JOIN prev ON prev.card_id = l.card_id
        WHERE l.price IS NOT NULL AND prev.price IS NOT NULL AND prev.price > 0
        ORDER BY pct DESC
        LIMIT ?
      `).bind(limit).all();

      const losers = await env.DB.prepare(`
        WITH r AS (
          SELECT p.card_id, c.name, c.set_name, c.image_url,
                 COALESCE(p.price_usd, p.price_eur) AS price,
                 p.as_of,
                 ROW_NUMBER() OVER (PARTITION BY p.card_id ORDER BY p.as_of DESC) AS rn
          FROM prices_daily p
          JOIN cards c ON c.id = p.card_id
        ),
        l AS (SELECT * FROM r WHERE rn=1),
        prev AS (SELECT * FROM r WHERE rn=2)
        SELECT l.card_id, l.name, l.set_name, l.image_url,
               l.price AS price_now, prev.price AS price_prev,
               ROUND( ( (l.price - prev.price) / prev.price ) * 100.0, 2 ) AS pct
        FROM l JOIN prev ON prev.card_id = l.card_id
        WHERE l.price IS NOT NULL AND prev.price IS NOT NULL AND prev.price > 0
        ORDER BY pct ASC
        LIMIT ?
      `).bind(limit).all();

      return json({
        ok: true,
        as_of,
        gainers: gainers.results ?? [],
        losers: losers.results ?? []
      });
    }

    // ----- Public lists -----
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

    // ----- Subscriptions -----
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email || !isValidEmail(email)) return json({ error: 'valid email required' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR REPLACE INTO subscriptions (id,kind,target,created_at)
        VALUES (?,?,?,?)
      `).bind(id, 'email', email, new Date().toISOString()).run();
      return json({ ok: true });
    }

    // ----- Trends ingest (GitHub Action) -----
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

    // ----- Health -----
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

    // ----- Portfolio -----
    if (url.pathname === '/portfolio/create' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare(`
        INSERT OR REPLACE INTO portfolios (id, secret, created_at) VALUES (?, ?, ?)
      `).bind(id, secret, new Date().toISOString()).run();
      return json({ id, secret, note: 'Store these safely. They act as your login token.' });
    }

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
      const auth = await authPortfolio(req, env);
      if (!auth.ok) return json({ error: auth.err }, auth.status);

      const lotsRes = await env.DB.prepare(`
        SELECT id, card_id, qty, cost_usd, acquired_at, note
        FROM lots WHERE portfolio_id=? ORDER BY acquired_at ASC, id ASC
      `).bind(auth.portfolio_id).all();
      const lots = lotsRes.results ?? [];

      const byCard = new Map<string, { qty:number, cost_usd:number, lots:any[] }>();
      for (const l of lots) {
        const k = l.card_id;
        const g = byCard.get(k) ?? { qty: 0, cost_usd: 0, lots: [] };
        g.qty += Number(l.qty) || 0;
        g.cost_usd += Number(l.cost_usd) || 0;
        g.lots.push(l);
        byCard.set(k, g);
      }

      const rows: any[] = [];
      for (const [card_id, agg] of byCard.entries()) {
        const meta = await env.DB.prepare(`SELECT name, set_name, image_url FROM cards WHERE id=?`).bind(card_id).all();
        const m = meta.results?.[0] ?? { name: card_id, set_name: '', image_url: '' };

        const px = await env.DB.prepare(`
          SELECT price_usd, price_eur, as_of
          FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1
        `).bind(card_id).all();
        const p = px.results?.[0] ?? { price_usd: null, price_eur: null, as_of: null };

        const last_usd = (p.price_usd as number | null);
        const last_eur = (p.price_eur as number | null);
        const as_of = p.as_of as string | null;

        const mv = last_usd != null ? (agg.qty * last_usd) : null;
        const pnl = (last_usd != null) ? (mv! - agg.cost_usd) : null;
        const roi = (last_usd != null && agg.cost_usd > 0) ? (pnl! / agg.cost_usd) * 100 : null;

        rows.push({
          card_id, name: m.name, set_name: m.set_name, image_url: m.image_url,
          qty: Number(agg.qty.toFixed(4)), cost_usd: Number(agg.cost_usd.toFixed(2)),
          price_usd: last_usd, price_eur: last_eur, price_as_of: as_of,
          market_value_usd: mv != null ? Number(mv.toFixed(2)) : null,
          pnl_usd: pnl != null ? Number(pnl.toFixed(2)) : null,
          roi_pct: roi != null ? Number(roi.toFixed(2)) : null
        });
      }

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

    // ----- Alerts: create/deactivate/admin -----
    if (url.pathname === '/alerts/create' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const email = (body?.email ?? '').toString().trim();
      const card_id = (body?.card_id ?? '').toString().trim();
      const kind = (body?.kind ?? '').toString().trim(); // 'price_above' | 'price_below'
      const threshold = Number(body?.threshold);

      if (!isValidEmail(email)) return json({ error: 'valid email required' }, 400);
      if (!card_id) return json({ error: 'card_id required' }, 400);
      if (kind !== 'price_above' && kind !== 'price_below') return json({ error: 'kind must be price_above or price_below' }, 400);
      if (!Number.isFinite(threshold) || threshold <= 0) return json({ error: 'threshold must be > 0' }, 400);

      const meta = await env.DB.prepare(`SELECT name, set_name FROM cards WHERE id=?`).bind(card_id).all();
      if (!meta.results?.length) return json({ error: 'unknown card_id' }, 404);

      const id = crypto.randomUUID();
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      const manage = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

      await env.DB.prepare(`
        INSERT INTO alerts_watch (id, email, card_id, kind, threshold_usd, created_at, manage_token)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(id, email, card_id, kind, threshold, new Date().toISOString(), manage).run();

      const link = `${baseUrl(env)}/alerts/deactivate?id=${id}&token=${manage}`;
      const subj = `PokeQuant: alert created (${kind} @ $${threshold.toFixed(2)})`;
      const html = `
        <p>Your alert has been created for <b>${meta.results[0].name}</b> (${meta.results[0].set_name}).</p>
        <p>Condition: <code>${kind}</code> @ $${threshold.toFixed(2)}</p>
        <p>Manage: <a href="${link}">Deactivate this alert</a></p>
        <p><small>Keep this email. Anyone with the link can deactivate the alert.</small></p>
      `;
      await sendEmail(env, email, subj, html);

      return json({ ok: true, id, manage_token: manage });
    }

    if (url.pathname === '/alerts/deactivate' && req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      const id = (body?.id ?? '').toString().trim();
      const token = (body?.token ?? '').toString().trim();
      if (!id || !token) return json({ error: 'id and token required' }, 400);

      const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
      const m = row.results?.[0]?.manage_token as string | undefined;
      if (!m || m !== token) return json({ error: 'invalid token' }, 403);

      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }

    if (url.pathname === '/alerts/deactivate' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      const token = (url.searchParams.get('token') || '').trim();
      let msg = '';
      if (!id || !token) {
        msg = 'Missing id or token.';
      } else {
        const row = await env.DB.prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`).bind(id).all();
        const m = row.results?.[0]?.manage_token as string | undefined;
        if (!m || m !== token) {
          msg = 'Invalid token.';
        } else {
          await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();
          msg = 'Alert deactivated.';
        }
      }
      const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title>
      <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px">
        <h3>${msg}</h3>
        <p><a href="${baseUrl(env)}">Back to PokeQuant</a></p>
      </body>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
    }

    if (url.pathname === '/admin/run-alerts' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const out = await runAlerts(env);
      return json({ ok: true, ...out });
    }

    // ----- Admin -----
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const out = await pipelineRun(env);
      return json({ ok: true, ...out });
    }
    if (url.pathname === '/admin/test-email' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(()=>({}));
      const to = (body?.to ?? '').toString().trim();
      if (!to) return json({ error: 'no recipient provided' }, 400);
      const res = await sendEmail(env, to, 'PokeQuant — Test email', `<p>This is a test email from PokeQuant admin.</p>`);
      return json({ ok: res.ok });
    }

    // ----- Root -----
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    const result = await pipelineRun(env);
    console.log('[scheduled] cards=%d pricesToday=%d signalsToday=%d alerts=%j timings(ms)=%j',
      result.cardCount, result.pricesForToday, result.signalsForToday, result.alerts, result.timingsMs);
  }
};
