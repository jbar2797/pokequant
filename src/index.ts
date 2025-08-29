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

/** ---------------------- small utils ---------------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}
function isoDaysAgo(days: number) {
  const t = Date.now() - Math.max(0, days) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** ---------------------- core ETL steps ---------------------- */
async function fetchUniverse(env: Env) {
  // Curated rarities; exclude Japanese to reduce variant noise for MVP
  const rarities = [
    'Special illustration rare',
    'Illustration rare',
    'Ultra Rare',
    'Rare Secret',
    'Rare Rainbow',
    'Full Art',
    'Promo',
  ];
  const q = encodeURIComponent(
    rarities.map((r) => `rarity:"${r}"`).join(' OR ') + ' -set.series:"Japanese"'
  );
  const url = `https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=250&orderBy=-set.releaseDate`;
  const res = await fetch(url, { headers: { 'X-Api-Key': env.PTCG_API_KEY } });
  if (!res.ok) throw new Error(`PTCG ${res.status}`);
  const js = await res.json();
  return js.data ?? [];
}

async function upsertCards(env: Env, cards: any[]) {
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const types = Array.isArray(c.types) ? c.types.join('|') : c.types ?? null;
    const subtypes = Array.isArray(c.subtypes) ? c.subtypes.join('|') : c.subtypes ?? null;
    batch.push(
      env.DB
        .prepare(
          `INSERT OR REPLACE INTO cards
           (id,name,set_id,set_name,number,rarity,image_url,tcgplayer_url,cardmarket_url,supertype,subtypes,types)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          c.id,
          c.name,
          c.set?.id ?? null,
          c.set?.name ?? null,
          c.number ?? null,
          c.rarity ?? null,
          c.images?.small ?? null,
          c.tcgplayer?.url ?? null,
          c.cardmarket?.url ?? null,
          c.supertype ?? null,
          subtypes,
          types
        )
    );
  }
  if (batch.length) await env.DB.batch(batch);
}

async function snapshotPrices(env: Env, cards: any[]) {
  const today = new Date().toISOString().slice(0, 10);
  const batch: D1PreparedStatement[] = [];
  for (const c of cards) {
    const tp = c.tcgplayer,
      cm = c.cardmarket;
    const usd = tp?.prices
      ? (() => {
          const any = Object.values(tp.prices)[0] as any;
          return any?.market ?? any?.mid ?? null;
        })()
      : null;
    const eur = cm?.prices?.trendPrice ?? cm?.prices?.avg7 ?? cm?.prices?.avg30 ?? null;

    batch.push(
      env.DB
        .prepare(
          `INSERT OR REPLACE INTO prices_daily
           (card_id, as_of, price_usd, price_eur, src_updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(c.id, today, usd, eur, tp?.updatedAt || cm?.updatedAt || null)
    );
  }
  if (batch.length) await env.DB.batch(batch);
}

async function computeSignals(env: Env) {
  const today = new Date().toISOString().slice(0, 10);
  const cards = await env.DB.prepare(`SELECT id FROM cards`).all();

  for (const row of (cards.results ?? []) as any[]) {
    const px = await env.DB
      .prepare(
        `SELECT as_of, COALESCE(price_usd, price_eur) AS p
         FROM prices_daily WHERE card_id=? ORDER BY as_of ASC`
      )
      .bind(row.id)
      .all();

    const svi = await env.DB
      .prepare(`SELECT as_of, svi FROM svi_daily WHERE card_id=? ORDER BY as_of ASC`)
      .bind(row.id)
      .all();

    const prices = (px.results ?? []).map((r: any) => r.p).filter((x: any) => typeof x === 'number');
    const svis = (svi.results ?? []).map((r: any) => Number(r.svi) || 0);

    // Allow SVI-only path; but require at least prices>=1 and svis>=14 OR prices>=7
    if (!(prices.length >= 7 || svis.length >= 14)) continue;

    const out = compositeScore(prices, svis);
    const { score, signal, reasons, edgeZ, expRet, expSd, components } = out;

    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO signals_daily
         (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.id, today, score, signal, JSON.stringify(reasons), edgeZ, expRet, expSd)
      .run();

    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO signal_components_daily
         (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        today,
        components.ts7,
        components.ts30,
        components.dd,
        components.vol,
        components.zSVI,
        components.regimeBreak ? 1 : 0
      )
      .run();
  }
}

async function sendSignalChangeEmails(env: Env) {
  const rows = await env.DB
    .prepare(
      `WITH sorted AS (
         SELECT card_id, signal, as_of,
                LAG(signal) OVER (PARTITION BY card_id ORDER BY as_of) AS prev_signal
         FROM signals_daily
       )
       SELECT s.card_id, s.signal, s.prev_signal, c.name, c.set_name
       FROM sorted s JOIN cards c ON c.id = s.card_id
       WHERE s.as_of = (SELECT MAX(as_of) FROM signals_daily)
         AND s.prev_signal IS NOT NULL AND s.signal <> s.prev_signal`
    )
    .all();
  if (!rows.results?.length) return;

  const subs = await env.DB.prepare(`SELECT target FROM subscriptions WHERE kind='email'`).all();
  if (!subs.results?.length) return;

  const list = rows.results as any[];
  const body = `<h3>Signal changes today</h3>
    <ul>${list
      .map(
        (r) =>
          `<li><b>${r.name}</b> (${r.set_name}): ${r.prev_signal} → <b>${r.signal}</b></li>`
      )
      .join('')}</ul>`;

  // fire-and-forget
  for (const s of subs.results as any[]) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'PokeQuant <alerts@pokequant.dev>',
        to: [s.target],
        subject: 'PokeQuant — Signal changes',
        html: body,
      }),
    }).catch(() => {});
  }
}

async function runAlerts(env: Env) {
  // Simple price threshold alerts
  const alerts = await env.DB
    .prepare(
      `SELECT id, email, card_id, kind, threshold, active, last_fired_at
       FROM alerts_watch
       WHERE active=1`
    )
    .all();
  const list = (alerts.results ?? []) as any[];
  if (!list.length) return { checked: 0, fired: 0 };

  let fired = 0;
  for (const a of list) {
    const px = await env.DB
      .prepare(
        `SELECT COALESCE(price_usd, price_eur) AS price, as_of
         FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`
      )
      .bind(a.card_id)
      .all();
    const p = px.results?.[0]?.price as number | null;
    if (p == null) continue;

    let trig = false;
    if (a.kind === 'price_below' && Number(p) <= Number(a.threshold)) trig = true;
    if (a.kind === 'price_above' && Number(p) >= Number(a.threshold)) trig = true;

    // avoid firing more than once per day
    const today = new Date().toISOString().slice(0, 10);
    if (trig && a.last_fired_at !== today) {
      fired++;
      await env.DB
        .prepare(`UPDATE alerts_watch SET last_fired_at=? WHERE id=?`)
        .bind(today, a.id)
        .run();

      // email
      const c = await env.DB
        .prepare(`SELECT name,set_name,image_url FROM cards WHERE id=?`)
        .bind(a.card_id)
        .all();
      const card = c.results?.[0] ?? {};
      const body = `<p>Your alert fired: <b>${card.name || a.card_id}</b>${
        card.set_name ? ' (' + card.set_name + ')' : ''
      } — current price ${p}</p>`;
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'PokeQuant <alerts@pokequant.dev>',
          to: [a.email],
          subject: 'PokeQuant — Price alert',
          html: body,
        }),
      }).catch(() => {});
    }
  }
  return { checked: list.length, fired };
}

/** ---------------------- HTTP ---------------------- */
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    /** ---------- discovery lists ---------- */
    if (url.pathname === '/api/sets' && req.method === 'GET') {
      const rs = await env.DB
        .prepare(`SELECT DISTINCT set_name AS v FROM cards WHERE set_name IS NOT NULL ORDER BY set_name`)
        .all();
      return json((rs.results ?? []).map((r: any) => r.v));
    }
    if (url.pathname === '/api/rarities' && req.method === 'GET') {
      const rs = await env.DB
        .prepare(`SELECT DISTINCT rarity AS v FROM cards WHERE rarity IS NOT NULL ORDER BY rarity`)
        .all();
      return json((rs.results ?? []).map((r: any) => r.v));
    }
    if (url.pathname === '/api/types' && req.method === 'GET') {
      const rs = await env.DB
        .prepare(`SELECT types FROM cards WHERE types IS NOT NULL AND length(types)>0`)
        .all();
      const out = new Set<string>();
      for (const row of rs.results ?? []) {
        const s = String(row.types);
        for (const t of s.split('|')) {
          const tt = t.trim();
          if (tt) out.add(tt);
        }
      }
      return json(Array.from(out.values()).sort());
    }

    /** ---------- search ---------- */
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const set = (url.searchParams.get('set') || '').trim();
      const rarity = (url.searchParams.get('rarity') || '').trim();
      const type = (url.searchParams.get('type') || '').trim();
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

      const where: string[] = [];
      const binds: any[] = [];

      if (q) {
        where.push('(c.name LIKE ? OR c.number LIKE ?)');
        const pat = `%${q}%`;
        binds.push(pat, pat);
      }
      if (set) {
        where.push('c.set_name = ?');
        binds.push(set);
      }
      if (rarity) {
        where.push('c.rarity = ?');
        binds.push(rarity);
      }
      if (type) {
        where.push('c.types LIKE ?');
        binds.push(`%${type}%`);
      }

      const sql = `
        SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
               s.signal, ROUND(s.score,1) AS score,
               (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
               (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
        FROM cards c
        LEFT JOIN signals_daily s
          ON s.card_id=c.id AND s.as_of = (SELECT MAX(as_of) FROM signals_daily)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(s.score,0) DESC, c.set_name, c.name
        LIMIT ? OFFSET ?`;
      binds.push(limit, offset);

      const rs = await env.DB.prepare(sql).bind(...binds).all();
      return json(rs.results ?? []);
    }

    /** ---------- movers ---------- */
    if (url.pathname === '/api/movers' && req.method === 'GET') {
      const n = Math.min(50, Math.max(1, parseInt(url.searchParams.get('n') || '12', 10)));
      const rs = await env.DB
        .prepare(
          `WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
           SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
                  s.signal, ROUND(s.score,1) AS score,
                  sc.ts7, sc.z_svi,
                  (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
                  (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
           FROM signals_daily s
           JOIN latest L ON s.as_of=L.d
           JOIN cards c ON c.id=s.card_id
           LEFT JOIN signal_components_daily sc ON sc.card_id=s.card_id AND sc.as_of=s.as_of
           ORDER BY COALESCE(sc.z_svi, 0) DESC, COALESCE(sc.ts7, 0) DESC, s.score DESC
           LIMIT ?`
        )
        .bind(n)
        .all();
      return json(rs.results ?? []);
    }

    /** ---------- card timeseries & CSV ---------- */
    if (url.pathname === '/api/card' && req.method === 'GET') {
      const id = (url.searchParams.get('id') || '').trim();
      let days = parseInt(url.searchParams.get('days') || '120', 10);
      if (!Number.isFinite(days) || days < 7) days = 120;
      if (days > 365) days = 365;
      const since = isoDaysAgo(days);
      if (!id) return json({ error: 'id required' }, 400);

      const meta = await env.DB
        .prepare(`SELECT id,name,set_name,rarity,image_url FROM cards WHERE id=? LIMIT 1`)
        .bind(id)
        .all();
      const card = meta.results?.[0];
      if (!card) return json({ error: 'unknown card_id' }, 404);

      const [pRs, sRs, gRs, cRs] = await Promise.all([
        env.DB
          .prepare(
            `SELECT as_of AS d, price_usd AS usd, price_eur AS eur
             FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
        env.DB
          .prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`)
          .bind(id, since)
          .all(),
        env.DB
          .prepare(
            `SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd
             FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
        env.DB
          .prepare(
            `SELECT as_of AS d, ts7, ts30, dd, vol, z_svi, regime_break
             FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
      ]);

      return json({
        ok: true,
        card,
        prices: pRs.results ?? [],
        svi: sRs.results ?? [],
        signals: gRs.results ?? [],
        components: cRs.results ?? [],
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
        env.DB
          .prepare(
            `SELECT as_of AS d, price_usd AS usd, price_eur AS eur
             FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
        env.DB
          .prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`)
          .bind(id, since)
          .all(),
        env.DB
          .prepare(
            `SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd
             FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
        env.DB
          .prepare(
            `SELECT as_of AS d, ts7, ts30, dd, vol, z_svi
             FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`
          )
          .bind(id, since)
          .all(),
      ]);

      const prices = (pRs.results ?? []) as any[];
      const svi = (sRs.results ?? []) as any[];
      const sig = (gRs.results ?? []) as any[];
      const comp = (cRs.results ?? []) as any[];

      const map = new Map<string, any>();
      for (const r of prices) map.set(r.d, { d: r.d, usd: r.usd ?? '', eur: r.eur ?? '' });
      for (const r of svi) (map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d)).svi = r.svi ?? '';
      for (const r of sig) {
        const row = map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d);
        row.signal = r.signal ?? '';
        row.score = r.score ?? '';
        row.edge_z = r.edge_z ?? '';
        row.exp_ret = r.exp_ret ?? '';
        row.exp_sd = r.exp_sd ?? '';
      }
      for (const r of comp) {
        const row = map.get(r.d) || map.set(r.d, { d: r.d }).get(r.d);
        row.ts7 = r.ts7 ?? '';
        row.ts30 = r.ts30 ?? '';
        row.dd = r.dd ?? '';
        row.vol = r.vol ?? '';
        row.z_svi = r.z_svi ?? '';
      }
      const dates = Array.from(map.keys()).sort();
      const header = [
        'date',
        'price_usd',
        'price_eur',
        'svi',
        'signal',
        'score',
        'edge_z',
        'exp_ret',
        'exp_sd',
        'ts7',
        'ts30',
        'dd',
        'vol',
        'z_svi',
      ];
      const lines = [header.join(',')];
      for (const d of dates) {
        const r = map.get(d);
        lines.push(
          [
            d,
            r.usd ?? '',
            r.eur ?? '',
            r.svi ?? '',
            r.signal ?? '',
            r.score ?? '',
            r.edge_z ?? '',
            r.exp_ret ?? '',
            r.exp_sd ?? '',
            r.ts7 ?? '',
            r.ts30 ?? '',
            r.dd ?? '',
            r.vol ?? '',
            r.z_svi ?? '',
          ].join(',')
        );
      }
      const csv = lines.join('\n');
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${id}_last${days}d.csv"`,
          ...CORS,
        },
      });
    }

    /** ---------- public surfaces ---------- */
    if (url.pathname === '/api/cards' && req.method === 'GET') {
      const rs = await env.DB
        .prepare(
          `SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
                  s.signal, ROUND(s.score,1) AS score,
                  (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
                  (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
           FROM cards c
           LEFT JOIN signals_daily s
             ON s.card_id=c.id AND s.as_of=(SELECT MAX(as_of) FROM signals_daily)
           WHERE s.signal IS NOT NULL
           ORDER BY s.score DESC
           LIMIT 250`
        )
        .all();
      return json(rs.results ?? []);
    }

    if (url.pathname === '/api/universe' && req.method === 'GET') {
      const rs = await env.DB
        .prepare(
          `SELECT c.id, c.name, c.set_name, c.rarity, c.image_url,
                  (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
                  (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
           FROM cards c
           ORDER BY c.set_name, c.name
           LIMIT 250`
        )
        .all();
      return json(rs.results ?? []);
    }

    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const email = (body?.email ?? '').toString().trim();
      if (!email) return json({ error: 'email required' }, 400);
      const id = crypto.randomUUID();
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO subscriptions (id, kind, target, created_at)
           VALUES (?,?,?,?)`
        )
        .bind(id, 'email', email, new Date().toISOString())
        .run();
      return json({ ok: true });
    }

    /** ---------- Alerts ---------- */
    if (url.pathname === '/alerts/create' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const email = (body?.email || '').toString().trim();
      const card_id = (body?.card_id || '').toString().trim();
      const kind = (body?.kind || '').toString().trim(); // price_below | price_above
      const threshold = Number(body?.threshold);
      if (!email || !card_id || !kind || !Number.isFinite(threshold))
        return json({ error: 'email, card_id, kind, threshold required' }, 400);
      if (!['price_below', 'price_above'].includes(kind))
        return json({ error: 'kind must be price_below or price_above' }, 400);

      const manage_token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const id = crypto.randomUUID();
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO alerts_watch
           (id,email,card_id,kind,threshold,active,manage_token,created_at)
           VALUES (?,?,?,?,?,1,?,?)`
        )
        .bind(id, email, card_id, kind, threshold, manage_token, new Date().toISOString())
        .run();

      // send a manage link
      const base = env.PUBLIC_BASE_URL || 'https://pokequant.pages.dev';
      const link = `${base}/alerts/deactivate?id=${encodeURIComponent(id)}&token=${encodeURIComponent(
        manage_token
      )}`;
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'PokeQuant <alerts@pokequant.dev>',
          to: [email],
          subject: 'PokeQuant — Alert created',
          html: `<p>Your alert for <code>${card_id}</code> is active.</p><p>One‑click disable: <a href="${link}">${link}</a></p>`,
        }),
      }).catch(() => {});

      return json({ ok: true, id, manage_token });
    }

    if (url.pathname === '/alerts/deactivate' && (req.method === 'GET' || req.method === 'POST')) {
      let id = '',
        token = '';
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        id = (body?.id || '').toString().trim();
        token = (body?.token || '').toString().trim();
      } else {
        id = (url.searchParams.get('id') || '').trim();
        token = (url.searchParams.get('token') || '').trim();
      }
      if (!id || !token) return json({ error: 'id & token required' }, 400);

      const row = await env.DB
        .prepare(`SELECT manage_token FROM alerts_watch WHERE id=?`)
        .bind(id)
        .all();
      const keep = row.results?.[0]?.manage_token;
      if (!keep || keep !== token) return json({ error: 'forbidden' }, 403);

      await env.DB.prepare(`UPDATE alerts_watch SET active=0 WHERE id=?`).bind(id).run();

      if (req.method === 'GET') {
        const html = `<!doctype html><meta charset="utf-8"><title>PokeQuant</title>
        <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu; padding:24px">
          <h3>Alert deactivated.</h3>
          <p><a href="${env.PUBLIC_BASE_URL || 'https://pokequant.pages.dev'}">Back to PokeQuant</a></p>
        </body>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });
      }
      return json({ ok: true });
    }

    /** ---------- health & admin ---------- */
    if (url.pathname === '/health' && req.method === 'GET') {
      try {
        const [cards, prices, signals, svi, dP, dS, dG] = await Promise.all([
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
            svi_daily: svi.results?.[0]?.n ?? 0,
          },
          latest: {
            prices_daily: dP.results?.[0]?.d ?? null,
            signals_daily: dS.results?.[0]?.d ?? null,
            svi_daily: dG.results?.[0]?.d ?? null,
          },
        });
      } catch (e: any) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (url.pathname === '/admin/diag' && req.method === 'GET') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok: false, error: 'forbidden' }, 403);
      const [svi14, px1, px7, sigRows, dP, dG, dS] = await Promise.all([
        env.DB
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT card_id FROM svi_daily GROUP BY card_id HAVING COUNT(*)>=14
             )`
          )
          .all(),
        env.DB
          .prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*)>=1)`)
          .all(),
        env.DB
          .prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*)>=7)`)
          .all(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily)`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
        env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
      ]);
      return json({
        ok: true,
        cards_with_svi14_plus: svi14.results?.[0]?.n ?? 0,
        cards_with_price1_plus: px1.results?.[0]?.n ?? 0,
        cards_with_price7_plus: px7.results?.[0]?.n ?? 0,
        signals_rows_latest: sigRows.results?.[0]?.n ?? 0,
        latest_price_date: dP.results?.[0]?.d ?? null,
        latest_svi_date: dG.results?.[0]?.d ?? null,
        latest_signal_date: dS.results?.[0]?.d ?? null,
      });
    }

    if (url.pathname === '/admin/run-now' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok: false, error: 'forbidden' }, 403);
      try {
        const t0 = Date.now();
        let universe: any[] = [];
        try {
          universe = await fetchUniverse(env);
          await upsertCards(env, universe);
        } catch (e) {
          // If PTCG hiccups, continue with existing cards
          universe = [];
        }
        const t1 = Date.now();
        if (universe.length) await snapshotPrices(env, universe);
        const t2 = Date.now();
        await computeSignals(env);
        const t3 = Date.now();
        const alerts = await runAlerts(env);
        const t4 = Date.now();
        await sendSignalChangeEmails(env);
        const t5 = Date.now();

        const today = new Date().toISOString().slice(0, 10);
        const [pN, sN] = await Promise.all([
          env.DB
            .prepare(`SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`)
            .bind(today)
            .all(),
          env.DB
            .prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`)
            .bind(today)
            .all(),
        ]);

        return json({
          ok: true,
          cardCount: universe.length || (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all()).results?.[0]?.n || 0,
          pricesForToday: pN.results?.[0]?.n ?? 0,
          signalsForToday: sN.results?.[0]?.n ?? 0,
          timingsMs: {
            fetchUpsert: t1 - t0,
            prices: t2 - t1,
            signals: t3 - t2,
            alerts: t4 - t3,
            emails: t5 - t4,
            total: t5 - t0,
          },
          alerts,
        });
      } catch (e: any) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (url.pathname === '/admin/run-alerts' && req.method === 'POST') {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok: false, error: 'forbidden' }, 403);
      try {
        const out = await runAlerts(env);
        return json({ ok: true, ...out });
      } catch (e: any) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    /** ---------- root ---------- */
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /health', { headers: CORS });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    try {
      await computeSignals(env);
      await runAlerts(env);
      await sendSignalChangeEmails(env);
    } catch (_e) {
      // ignore; will try tomorrow
    }
  },
};
