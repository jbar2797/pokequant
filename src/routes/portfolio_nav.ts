import { router } from '../router';
import { json } from '../lib/http';
import type { Env } from '../lib/types';
import { snapshotPortfolioNAV, computePortfolioPnL } from '../lib/portfolio_nav';

function admin(env: Env, req: Request) { return req.headers.get('x-admin-token') === env.ADMIN_TOKEN; }

export function registerPortfolioNavRoutes() {
  router
    .add('GET','/admin/portfolio-nav', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT portfolio_id, as_of, market_value FROM portfolio_nav ORDER BY as_of DESC LIMIT 500`).all();
      return json({ ok:true, rows: rs.results||[] });
    })
    .add('POST','/admin/portfolio-nav/snapshot', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      await snapshotPortfolioNAV(env);
      return json({ ok:true });
    })
    .add('GET','/admin/portfolio-pnl', async ({ env, req, url }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      await computePortfolioPnL(env);
      const pid = url.searchParams.get('portfolio_id');
      let rows; if (pid) {
        rows = await env.DB.prepare(`SELECT portfolio_id, as_of, ret, turnover_cost, realized_pnl FROM portfolio_pnl WHERE portfolio_id=? ORDER BY as_of DESC LIMIT 180`).bind(pid).all();
      } else {
        rows = await env.DB.prepare(`SELECT portfolio_id, as_of, ret, turnover_cost, realized_pnl FROM portfolio_pnl ORDER BY as_of DESC, portfolio_id ASC LIMIT 500`).all();
      }
      return json({ ok:true, rows: (rows.results||[]) });
    });
}

registerPortfolioNavRoutes();
