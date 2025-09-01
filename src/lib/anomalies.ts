import type { Env } from './types';
import { log } from './log';

export async function detectAnomalies(env: Env) {
  if ((env as any).FAST_TESTS === '1') return; // skip heavy scan in fast tests
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS anomalies (id TEXT PRIMARY KEY, as_of DATE, card_id TEXT, kind TEXT, magnitude REAL, created_at TEXT);`).run();
    const rs = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest))
      SELECT c.id AS card_id,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id AND p.as_of=(SELECT d FROM latest)) AS px_l,
        (SELECT price_usd FROM prices_daily p WHERE p.card_id=c.id AND p.as_of=(SELECT d FROM prev)) AS px_p
      FROM cards c`).all();
    const today = new Date().toISOString().slice(0,10);
    for (const r of (rs.results||[]) as any[]) {
      const a = Number(r.px_p)||0, b=Number(r.px_l)||0; if (!a||!b) continue;
      const ch = (b - a)/a;
      if (Math.abs(ch) >= 0.25) {
        const id = crypto.randomUUID();
        await env.DB.prepare(`INSERT OR REPLACE INTO anomalies (id, as_of, card_id, kind, magnitude, created_at) VALUES (?,?,?,?,?,datetime('now'))`).bind(id, today, r.card_id, ch>0? 'price_spike':'price_crash', ch).run();
      }
    }
  } catch (e) { log('anomaly_error', { error:String(e) }); }
}
