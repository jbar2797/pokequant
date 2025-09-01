import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import { incMetric } from '../lib/metrics';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import type { Env } from '../lib/types';
import { ensureTestSeed } from '../lib/data';

export function registerSearchRoutes(){
  router.add('GET','/api/search', async ({ env, req, url }) => {
    await ensureTestSeed(env);
    const ip = req.headers.get('cf-connecting-ip') || 'anon';
    const rlKey = `search:${ip}`;
    const cfg = getRateLimits(env).search;
    const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
  if (!rl.allowed) { await incMetric(env, 'rate_limited.search'); return err(ErrorCodes.RateLimited,429,{ retry_after: rl.reset - Math.floor(Date.now()/1000) }); }
    const q = (url.searchParams.get('q')||'').trim();
    const rarity = (url.searchParams.get('rarity')||'').trim();
    const setName = (url.searchParams.get('set')||'').trim();
    const type = (url.searchParams.get('type')||'').trim();
    let limit = parseInt(url.searchParams.get('limit')||'50',10); if (!Number.isFinite(limit)||limit<1) limit=50; if (limit>250) limit=250;
    const where: string[] = [];
    const binds: any[] = [];
    if (q) { where.push('(c.name LIKE ? OR c.id LIKE ?)'); const like = `%${q}%`; binds.push(like, like); }
    if (rarity) { where.push('c.rarity = ?'); binds.push(rarity); }
    if (setName) { where.push('c.set_name = ?'); binds.push(setName); }
    if (type) { where.push('c.types LIKE ?'); binds.push(`%${type}%`); }
    const whereSql = where.length ? 'WHERE '+ where.join(' AND ') : '';
    const sql = `WITH latest AS (SELECT MAX(as_of) AS d FROM signals_daily)
      SELECT c.id,c.name,c.set_name,c.rarity,c.image_url,c.types,c.number,
        (SELECT s.signal FROM signals_daily s WHERE s.card_id=c.id AND s.as_of=latest.d) AS signal,
        (SELECT ROUND(s.score,1) FROM signals_daily s WHERE s.card_id=c.id AND s.as_of=latest.d) AS score,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_usd,
        (SELECT price_eur FROM prices_daily p WHERE p.card_id=c.id ORDER BY as_of DESC LIMIT 1) AS price_eur
      FROM cards c, latest
      ${whereSql}
      ORDER BY COALESCE(score,0) DESC
      LIMIT ?`;
    binds.push(limit);
    const rs = await env.DB.prepare(sql).bind(...binds).all();
    await incMetric(env, 'search.query');
    return json(rs.results || []);
  });
}

registerSearchRoutes();
