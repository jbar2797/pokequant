import { log } from './log';
import type { Env } from './types';

// Snapshot current portfolio market values into portfolio_nav table
export async function snapshotPortfolioNAV(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_nav (portfolio_id TEXT, as_of DATE, market_value REAL, PRIMARY KEY(portfolio_id,as_of));`).run();
    const ports = await env.DB.prepare(`SELECT id FROM portfolios`).all();
    const today = new Date().toISOString().slice(0,10);
    for (const p of (ports.results||[]) as any[]) {
      const lots = await env.DB.prepare(`SELECT l.card_id,l.qty,(SELECT price_usd FROM prices_daily px WHERE px.card_id=l.card_id ORDER BY as_of DESC LIMIT 1) AS px FROM lots l WHERE l.portfolio_id=?`).bind(p.id).all();
      let mv=0; for (const r of (lots.results||[]) as any[]) { mv += (Number(r.px)||0) * (Number(r.qty)||0); }
      await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_nav (portfolio_id, as_of, market_value) VALUES (?,?,?)`).bind(p.id, today, mv).run();
    }
  } catch (e) { log('portfolio_nav_error', { error:String(e) }); }
}

// Compute per-portfolio daily PnL/returns from NAV history
export async function computePortfolioPnL(env: Env) {
  try {
    const navs = await env.DB.prepare(`SELECT portfolio_id, as_of, market_value FROM portfolio_nav ORDER BY as_of ASC`).all();
    const rows = (navs.results||[]) as any[];
    const byPortfolio: Record<string,{d:string; mv:number}[]> = {};
    for (const r of rows) { const pid=String(r.portfolio_id); const mv=Number(r.market_value)||0; const d=String(r.as_of||''); if (!d) continue; (byPortfolio[pid] ||= []).push({ d, mv }); }
    for (const [pid, arr] of Object.entries(byPortfolio)) {
      if (arr.length < 2) continue;
      arr.sort((a,b)=> a.d.localeCompare(b.d));
      for (let i=1;i<arr.length;i++) {
        const prev = arr[i-1], cur = arr[i];
        if (prev.mv>0 && cur.mv>0) {
          const ret = (cur.mv - prev.mv)/prev.mv;
          await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_pnl (portfolio_id, as_of, ret, turnover_cost, realized_pnl) VALUES (?,?,?,?,?)`)
            .bind(pid, cur.d, ret, 0, (cur.mv-prev.mv)).run();
        }
      }
    }
    return { ok:true };
  } catch (e) { log('portfolio_pnl_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}
