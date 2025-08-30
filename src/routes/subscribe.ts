import { router } from '../router';
import { json, err } from '../lib/http';
import { incMetric } from '../lib/metrics';
import { getRateLimits, rateLimit } from '../lib/rate_limit';
import type { Env } from '../lib/types';
import { log } from '../lib/log';

export function registerSubscribeRoutes(){
  router.add('POST','/api/subscribe', async ({ env, req }) => {
    const ip = req.headers.get('cf-connecting-ip') || 'anon';
    const rlKey = `sub:${ip}`;
    const cfg = getRateLimits(env).subscribe;
    const rl = await rateLimit(env, rlKey, cfg.limit, cfg.window);
    if (!rl.allowed) { await incMetric(env, 'rate_limited.subscribe'); return json({ ok:false, error:'rate_limited', retry_after: rl.reset - Math.floor(Date.now()/1000) }, 429); }
    const body: any = await req.json().catch(()=>({}));
    const email = (body && body.email ? String(body.email) : '').trim();
    if (!email) return err('email_required', 400);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, kind TEXT, target TEXT, created_at TEXT);`).run();
    const id = crypto.randomUUID();
    await env.DB.prepare(`INSERT OR REPLACE INTO subscriptions (id, kind, target, created_at) VALUES (?, 'email', ?, datetime('now'))`).bind(id, email).run();
    log('subscribe', { email });
    await incMetric(env, 'subscribe');
    return json({ ok: true });
  });
}

registerSubscribeRoutes();