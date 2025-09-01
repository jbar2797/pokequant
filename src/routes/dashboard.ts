import { router } from '../router';
import type { Env } from '../lib/types';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import { incMetric } from '../lib/metrics';

// Simple watchlist table: watchlist(card_id TEXT PRIMARY KEY, created_at TEXT)
async function ensureWatchlist(env: Env) {
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS watchlist (card_id TEXT PRIMARY KEY, created_at TEXT)` ).run(); } catch {/* ignore */}
}

router
  // Aggregated dashboard snapshot — top signals, recent movers, counts
  .add('GET','/api/dashboard', async ({ env, req }) => {
    const ip = req.headers.get('cf-connecting-ip') || 'anon';
    const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:dashboard:${ip}`, cfg.limit, cfg.window);
    if (!rl.allowed) { await incMetric(env,'rate_limited.public.dashboard'); return err(ErrorCodes.RateLimited,429,{ retry_after: rl.reset - Math.floor(Date.now()/1000) }); }
    // Latest day snapshot (signals + prices); limit sizes to remain lightweight (<= ~5KB JSON)
    const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily) SELECT c.id, c.name, c.set_name, c.rarity, c.image_url, s.signal, ROUND(s.score,1) AS score, (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd FROM cards c JOIN signals_daily s ON s.card_id=c.id, latest WHERE s.as_of=latest.d ORDER BY s.score DESC LIMIT 25`).all();
    const movers = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily) SELECT c.id, c.name, s.signal, ROUND(sc.z_svi,2) AS z_svi FROM cards c JOIN signals_daily s ON s.card_id=c.id LEFT JOIN signal_components_daily sc ON sc.card_id=c.id AND sc.as_of=s.as_of, latest WHERE s.as_of=latest.d ORDER BY COALESCE(sc.z_svi, s.edge_z, s.score) DESC LIMIT 15`).all();
    const counts = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM cards) AS cards, (SELECT COUNT(*) FROM signals_daily) AS signals_rows, (SELECT COUNT(*) FROM prices_daily) AS prices_rows`).all();
    return json({ ok:true, top: rs.results ?? [], movers: movers.results ?? [], counts: counts.results?.[0] ?? {} });
  })
  // List watchlist (joins latest signal + price)
  .add('GET','/api/watchlist', async ({ env, req }) => {
    await ensureWatchlist(env); const ip = req.headers.get('cf-connecting-ip') || 'anon';
    const cfg = getRateLimits(env).publicRead; const rl = await rateLimit(env, `pub:watchlist:${ip}`, cfg.limit, cfg.window);
    if (!rl.allowed) { await incMetric(env,'rate_limited.public.watchlist'); return err(ErrorCodes.RateLimited,429,{ retry_after: rl.reset - Math.floor(Date.now()/1000) }); }
    const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily) SELECT w.card_id AS id, c.name, c.set_name, c.rarity, c.image_url, s.signal, ROUND(s.score,1) AS score, (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd, w.created_at FROM watchlist w LEFT JOIN cards c ON c.id=w.card_id LEFT JOIN signals_daily s ON s.card_id=w.card_id, latest WHERE s.as_of=latest.d ORDER BY w.created_at DESC LIMIT 200`).all();
    return json({ ok:true, items: rs.results ?? [] });
  })
  // Add card to watchlist
  .add('POST','/api/watchlist', async ({ env, req }) => {
    await ensureWatchlist(env);
    let body: any = {}; try { body = await req.json(); } catch {/* ignore */}
    const id = (body.id || '').trim(); if (!id) return json({ ok:false, error:'id required' },400);
    await env.DB.prepare(`INSERT OR IGNORE INTO watchlist (card_id, created_at) VALUES (?,?)`).bind(id, new Date().toISOString()).run();
    return json({ ok:true, id });
  })
  // Remove card
  .add('DELETE','/api/watchlist', async ({ env, req, url }) => {
    await ensureWatchlist(env);
    const id = (url.searchParams.get('id') || '').trim(); if (!id) return json({ ok:false, error:'id required' },400);
    await env.DB.prepare(`DELETE FROM watchlist WHERE card_id=?`).bind(id).run();
    return json({ ok:true, id });
  });

// No explicit export (side-effect registration)
