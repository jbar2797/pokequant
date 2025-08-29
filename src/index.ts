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
  const ids = (await env.DB.prepare(`SELECT id FROM cards`).all()).results?.map((r:any)=> r.id) ?? [];
  let wrote = 0;

  for (const id of ids) {
    const px = await env.DB.prepare(`
      SELECT as_of, COALESCE(price_usd, price_eur) AS p
      FROM prices_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(id).all();

    const svi = await env.DB.prepare(`
      SELECT as_of, svi FROM svi_daily WHERE card_id=? ORDER BY as_of ASC
    `).bind(id).all();

    const prices = (px.results ?? []).map((r:any)=> Number(r.p)).filter(Number.isFinite);
    const svis   = (svi.results ?? []).map((r:any)=> Number(r.svi)).filter(Number.isFinite);

    // Allow SVI‑only signals if SVI >= 14
    if (prices.length < 7 && svis.length < 14) continue;

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

// ---------- Emails ----------
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

// ---------- Diagnostics ----------
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
    console.log('[pipeline] fetchUniverse failed (continuing with existing DB data):', String(e));
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

    // ---- Admin
    if (url.pathname === '/admin/diag' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      return json(await diag(env));
    }
    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      try { return json(await pipelineRun(env)); }
      catch (e:any) { return json({ ok:false, error:String(e) }, 500); }
    }

    // ---- Research: single-card timeseries JSON/CSV
    if (url.pathname === '/api/card' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const metaRs = await env.DB.prepare(`SELECT id, name, set_name, rarity, image_url FROM cards WHERE id=? LIMIT 1`)
        .bind(id).all();
      const card = metaRs.results?.[0]; if (!card) return json({ error: 'unknown card_id' }, 404);

      const [pricesRs, sviRs, sigRs, compRs] = await Promise.all([
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur
                        FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily
                        WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd
                        FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi, regime_break
                        FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all()
      ]);

      return json({ ok:true, card, prices: pricesRs.results ?? [], svi: sviRs.results ?? [],
                    signals: sigRs.results ?? [], components: compRs.results ?? [] });
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
        row.signal = r.signal ?? ''; row.score = r.score ?? ''; row.edge_z = r.edge_z ?? '';
        row.exp_ret = r.exp_ret ?? ''; row.exp_sd = r.exp_sd ?? '';
      }
      for (const r of comp) {
        const row = (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d));
        row.ts7 = r.ts7 ?? ''; row.ts30 = r.ts30 ?? ''; row.dd = r.dd ?? ''; row.vol = r.vol ?? ''; row.z_svi = r.z_svi ?? '';
      }

      const dates = Array.from(map.keys()).sort();
      const header = ['date','price_usd','price_eur','svi','signal','score','edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'];
      const lines = [header.join(',')];
      for (const d of dates) {
        const r = map.get(d);
        lines.push([d, r.usd ?? '', r.eur ?? '', r.svi ?? '', r.signal ?? '', r.score ?? '', r.edge_z ?? '',
                    r.exp_ret ?? '', r.exp_sd ?? '', r.ts7 ?? '', r.ts30 ?? '', r.dd ?? '', r.vol ?? '', r.z_svi ?? ''].join(','));
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

    // ---- Public lists
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

    // NEW: top movers by 7‑day momentum (fallback to score when ts7 is null)
    if (url.pathname === '/api/movers' && req.method === 'GET') {
      let n = parseInt(url.searchParams.get('n') || '24', 10);
      if (!Number.isFinite(n) || n < 4) n = 24;
      if (n > 60) n = 60;

      const rs = await env.DB.prepare(`
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) AS score,
               sc.ts7, sc.z_svi,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM signals_daily s
        JOIN cards c ON c.id = s.card_id
        LEFT JOIN signal_components_daily sc
               ON sc.card_id = s.card_id AND sc.as_of = s.as_of
        WHERE s.as_of = (SELECT MAX(as_of) FROM signals_daily)
        ORDER BY COALESCE(sc.ts7, 0) DESC, s.score DESC
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

    // ---- Subscribe
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

    // ---- Portfolio
    if (url.pathname === '/portfolio/create' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare(`INSERT INTO portfolios (id, secret, created_at) VALUES (?, ?, ?)`)
        .bind(id, secret, new Date().toISOString()).run();
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
      const note = (body?.note ?? '').toString().slice(0,200);

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
        FROM lots WHERE portfolio_id=?`).bind(auth.portfolio_id).all();
      const lots = lotsRes.results ?? [];

      const byCard = new Map<string, { qty:number, cost_usd:number, lots:any[] }>();
      for (const l of lots) {
        const g = byCard.get(l.card_id) ?? { qty:0, cost_usd:0, lots:[] };
        g.qty += Number(l.qty) || 0;
        g.cost_usd += Number(l.cost_usd) || 0;
        g.lots.push(l); byCard.set(l.card_id, g);
      }

      const rows:any[] = [];
      for (const [card_id, agg] of byCard.entries()) {
        const meta = await env.DB.prepare(`SELECT name, set_name, image_url FROM cards WHERE id=?`).bind(card_id).all();
        const m = meta.results?.[0] ?? { name: card_id, set_name:'', image_url:'' };
        const px = await env.DB.prepare(`
          SELECT price_usd, price_eur, as_of FROM prices_daily
          WHERE card_id=? ORDER BY as_of DESC LIMIT 1
        `).bind(card_id).all();
        const p = px.results?.[0] ?? { price_usd:null, price_eur:null, as_of:null };
        const last_usd = p.price_usd as number | null;
        const last_eur = p.price_eur as number | null;
        const as_of = p.as_of as string | null;
        const market_value_usd = last_usd != null ? agg.qty * last_usd : null;
        const pnl_usd = last_usd != null ? (market_value_usd! - agg.cost_usd) : null;
        const roi_pct = (last_usd != null && agg.cost_usd > 0) ? (pnl_usd! / agg.cost_usd) * 100 : null;

        rows.push({
          card_id, name:m.name, set_name:m.set_name, image_url:m.image_url,
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

      return json({ ok:true, totals: {
        cost_usd: Number(total_cost.toFixed(2)),
        market_value_usd: Number(total_mkt.toFixed(2)),
        pnl_usd: total_pnl,
        roi_pct: total_roi
      }, rows });
    }

    if (url.pathname === '/portfolio/export' && req.method === 'GET') {
      const auth = await authPortfolio(req, env);
      if (!auth.ok) return json({ error: auth.err }, auth.status);
      const lots = await env.DB.prepare(`
        SELECT id, card_id, qty, cost_usd, acquired_at, note
        FROM lots WHERE portfolio_id=? ORDER BY acquired_at ASC, id ASC
      `).bind(auth.portfolio_id).all();
      return json({ ok:true, portfolio_id: auth.portfolio_id, lots: lots.results ?? [] });
    }

    // ---- Ingest Trends (from GitHub Actions)
    if (url.pathname === '/ingest/trends' && req.method === 'POST') {
      if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ ok:false, error:'forbidden' }, 403);
      const payload = await req.json().catch(()=>({}));
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!rows.length) return json({ ok:true, rows: 0 });
      const batch: D1PreparedStatement[] = [];
      for (const r of rows) {
        batch.push(env.DB.prepare(`INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)`)
          .bind(r.card_id, r.as_of, r.svi));
      }
      await env.DB.batch(batch);
      return json({ ok:true, rows: rows.length });
    }

    // ---- Health
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

    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    const result = await pipelineRun(env);
    console.log('[scheduled] cards=%d pricesToday=%d signalsToday=%d timings(ms)=%j',
      result.cardCount, result.pricesForToday, result.signalsForToday, result.timingsMs);
  }
};
