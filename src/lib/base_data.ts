import type { Env } from './types';

// Shared signature for ETag generation across public endpoints.
// Includes counts and latest dates across multiple tables so cache busts when any base dataset changes.
// Format: v2:<cardCount>:<latestPrice>:<latestSignal>:<latestSvi>:<latestComponents>
export async function baseDataSignature(env: Env): Promise<string> {
  try {
    const rs = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM cards) AS cards,
      (SELECT MAX(as_of) FROM prices_daily) AS lp,
      (SELECT MAX(as_of) FROM signals_daily) AS ls,
      (SELECT MAX(as_of) FROM svi_daily) AS lv,
      (SELECT MAX(as_of) FROM signal_components_daily) AS lc`).all();
    const row: any = rs.results?.[0] || {};
    return `v2:${row.cards||0}:${row.lp||''}:${row.ls||''}:${row.lv||''}:${row.lc||''}`;
  } catch {
    return 'v2:0::::';
  }
}
