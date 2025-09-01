import { json } from '../lib/http';
import { isoDaysAgo } from '../lib/date';
import { incMetric, recordLatency } from '../lib/metrics';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import type { Env } from '../lib/types';
import { router } from '../router';
import { ensureTestSeed } from '../lib/data';
import { baseDataSignature } from '../lib/base_data';

// External helper declarations (others still in index.ts for now)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare function ensureIndices(env: Env): Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare function audit(env: Env, f: any): Promise<void>;

export function registerPublicRoutes(){
  router
    .add('GET','/health', async ({ env }) => {
      try {
        await env.DB.batch([
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_id TEXT, set_name TEXT, number TEXT, rarity TEXT, image_url TEXT, tcgplayer_url TEXT, cardmarket_url TEXT, types TEXT);`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id,as_of));`),
          env.DB.prepare(`CREATE TABLE IF NOT EXISTS svi_daily (card_id TEXT, as_of DATE, svi INTEGER, PRIMARY KEY(card_id,as_of));`)
        ]);
        const [cards, prices, signals, svi, lp, ls, lsv] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily`).all(),
          env.DB.prepare(`SELECT COUNT(*) AS n FROM svi_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
          env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
        ]);
        return json({ ok:true, counts: { cards: cards.results?.[0]?.n ?? 0, prices_daily: prices.results?.[0]?.n ?? 0, signals_daily: signals.results?.[0]?.n ?? 0, svi_daily: svi.results?.[0]?.n ?? 0 }, latest: { prices_daily: lp.results?.[0]?.d ?? null, signals_daily: ls.results?.[0]?.d ?? null, svi_daily: lsv.results?.[0]?.d ?? null } });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('GET','/api/universe', async ({ env, req }) => {
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:universe:${ip}`, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env,'rate_limited.public.universe'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) },429); }
      await ensureTestSeed(env); await incMetric(env,'universe.list');
      const sig = await baseDataSignature(env); const etag = `"${sig}:universe"`;
      if (req.headers.get('if-none-match') === etag) { await incMetric(env,'cache.hit.universe'); return new Response(null,{ status:304, headers:{ 'ETag': etag, 'Cache-Control':'public, max-age=60' } }); }
      const rs = await env.DB.prepare(`SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types, c.number, (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd, (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur FROM cards c ORDER BY c.set_name, c.name LIMIT 250`).all();
      const resp = json(rs.results ?? []); resp.headers.set('Cache-Control','public, max-age=60'); resp.headers.set('ETag', etag); return resp;
    })
    .add('GET','/api/cards', async ({ env, req }) => {
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:cards:${ip}`, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env,'rate_limited.public.cards'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) },429); }
      await ensureTestSeed(env); await incMetric(env,'cards.list');
      const sig = await baseDataSignature(env); const etag = `"${sig}:cards"`;
      if (req.headers.get('if-none-match') === etag) { await incMetric(env,'cache.hit.cards'); return new Response(null,{ status:304, headers:{ 'ETag': etag, 'Cache-Control':'public, max-age=30' } }); }
      const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily) SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.types, c.number, s.signal, ROUND(s.score,1) AS score, (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd, (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur FROM cards c JOIN signals_daily s ON s.card_id=c.id, latest WHERE s.as_of = latest.d ORDER BY s.score DESC LIMIT 250`).all();
      const resp = json(rs.results ?? []); resp.headers.set('Cache-Control','public, max-age=30'); resp.headers.set('ETag', etag); return resp;
    })
    .add('GET','/api/movers', async ({ env, req, url }) => {
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:movers:${ip}`, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env,'rate_limited.public.movers'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) },429); }
      await ensureTestSeed(env); await incMetric(env,'cards.movers');
      const sig = await baseDataSignature(env); const etag = `"${sig}:movers"`;
      if (req.headers.get('if-none-match') === etag) { await incMetric(env,'cache.hit.movers'); return new Response(null,{ status:304, headers:{ 'ETag': etag, 'Cache-Control':'public, max-age=30' } }); }
      const dir = (url.searchParams.get('dir') || 'up').toLowerCase(); const n = Math.min(50, Math.max(1, parseInt(url.searchParams.get('n') ?? '12', 10))); const order = dir === 'down' ? 'ASC' : 'DESC';
      const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily) SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, c.number, s.signal, ROUND(s.score,1) AS score, sc.ts7, sc.z_svi, (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd, (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur FROM cards c JOIN signals_daily s ON s.card_id=c.id LEFT JOIN signal_components_daily sc ON sc.card_id=c.id AND sc.as_of=s.as_of, latest WHERE s.as_of = latest.d ORDER BY COALESCE(sc.z_svi, s.edge_z, s.score) ${order} LIMIT ?`).bind(n).all();
      const resp = json(rs.results ?? []); resp.headers.set('Cache-Control','public, max-age=30'); resp.headers.set('ETag', etag); return resp;
    })
    .add('GET','/api/card', async ({ env, req, url }) => {
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:card:${ip}`, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env,'rate_limited.public.card'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) },429); }
      await incMetric(env,'card.detail');
      const id = (url.searchParams.get('id') || '').trim(); let days = parseInt(url.searchParams.get('days') || '120', 10); if (!Number.isFinite(days) || days < 7) days = 120; if (days > 365) days = 365; const since = isoDaysAgo(days); if (!id) return json({ error: 'id required' }, 400);
      const [meta, p, g, v, c] = await Promise.all([
        env.DB.prepare(`SELECT id,name,set_name,rarity,image_url FROM cards WHERE id=?`).bind(id).all(),
        env.DB.prepare(`SELECT as_of AS d, price_usd AS usd, price_eur AS eur FROM prices_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, signal, score, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, svi FROM svi_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
        env.DB.prepare(`SELECT as_of AS d, ts7, ts30, dd, vol, z_svi FROM signal_components_daily WHERE card_id=? AND as_of>=? ORDER BY as_of ASC`).bind(id, since).all(),
      ]);
      return json({ ok: true, card: meta.results?.[0] ?? null, prices: p.results ?? [], signals: g.results ?? [], svi: v.results ?? [], components: c.results ?? [] });
    })
    .add('GET','/research/card-csv', async ({ env, req, url }) => {
      const ip = req.headers.get('cf-connecting-ip') || 'anon';
      const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:cardcsv:${ip}`, cfg.limit, cfg.window);
      if (!rl.allowed) { await incMetric(env,'rate_limited.public.cardcsv'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) },429); }
      const id = (url.searchParams.get('id') || '').trim(); let days = parseInt(url.searchParams.get('days') || '120', 10); if (!Number.isFinite(days) || days < 7) days = 120; if (days > 365) days = 365; const since = isoDaysAgo(days); if (!id) return json({ error: 'id required' }, 400);
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
      const rows = Array.from(map.values()).sort((a,b)=> a.d.localeCompare(b.d));
      const header = ['d','usd','eur','svi','signal','score','edge_z','exp_ret','exp_sd','ts7','ts30','dd','vol','z_svi'];
      const csv = [header.join(','), ...rows.map(r=> header.map(h=> (r as any)[h] ?? '').join(','))].join('\n');
      return new Response(csv, { headers: { 'content-type': 'text/csv' } });
    });
}

registerPublicRoutes();
