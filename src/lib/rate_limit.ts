import type { Env } from './types';
import { log } from './log';

export interface RateLimitResult { allowed: boolean; remaining: number; limit: number; reset: number; }

export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
	try {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER);`).run();
		const now = Math.floor(Date.now()/1000);
		const windowStart = now - (now % windowSec);
		await env.DB.prepare(`
			INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
			ON CONFLICT(key) DO UPDATE SET
				count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
				window_start = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.window_start ELSE excluded.window_start END
		`).bind(key, windowStart).run();
		const row = await env.DB.prepare(`SELECT window_start, count FROM rate_limits WHERE key=?`).bind(key).all();
		const ws = Number(row.results?.[0]?.window_start) || windowStart;
		const count = Number(row.results?.[0]?.count) || 0;
		const reset = ws + windowSec;
		const remaining = Math.max(0, limit - count);
		if (count > limit) return { allowed:false, remaining:0, limit, reset };
		return { allowed:true, remaining, limit, reset };
	} catch (e) {
		log('rate_limit_error', { key, error:String(e) });
		return { allowed:true, remaining:limit, limit, reset: Math.floor(Date.now()/1000)+windowSec };
	}
}

export function getRateLimits(env: Env) {
	const p = (v: string|undefined, d: number) => { const n = parseInt(v||'',10); return Number.isFinite(n) && n>0 ? n : d; };
	return {
		search: { limit: p(env.RL_SEARCH_LIMIT, 30), window: p(env.RL_SEARCH_WINDOW_SEC, 300) },
		subscribe: { limit: p(env.RL_SUBSCRIBE_LIMIT, 5), window: p(env.RL_SUBSCRIBE_WINDOW_SEC, 86400) },
		alertCreate: { limit: p(env.RL_ALERT_CREATE_LIMIT, 10), window: p(env.RL_ALERT_CREATE_WINDOW_SEC, 86400) },
		publicRead: { limit: p((env as any).RL_PUBLIC_READ_LIMIT, 120), window: p((env as any).RL_PUBLIC_READ_WINDOW_SEC, 300) }
	} as const;
}

