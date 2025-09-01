import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import type { Env } from '../lib/types';
import { runBacktest } from '../lib/backtest';
import { audit } from '../lib/audit';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerBacktestRoutes() {
  router
    .add('POST','/admin/backtests', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      const body:any = await req.json().catch(()=>({}));
      const lookbackDays = Number(body.lookbackDays)||90;
      const txCostBps = Number(body.txCostBps)||0;
      const slippageBps = Number(body.slippageBps)||0;
      const out = await runBacktest(env, { lookbackDays, txCostBps, slippageBps });
      await audit(env, { actor_type:'admin', action:'backtest_run', resource:'backtest', resource_id:(out as any).id||null, details:{ lookbackDays } });
      return json(out);
    })
    .add('GET','/admin/backtests', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      const rs = await env.DB.prepare(`SELECT id, created_at, params, metrics FROM backtests ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rs.results||[] });
    })
    .add('GET','/admin/backtests/id', async ({ env, req, url }) => { // helper actual pattern: /admin/backtests/:id (simulate with query ?id=)
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      const id = (url.searchParams.get('id')||'').trim();
  if (!id) return err(ErrorCodes.IdRequired,400);
      const rs = await env.DB.prepare(`SELECT id, created_at, params, metrics, equity_curve FROM backtests WHERE id=?`).bind(id).all();
      return json({ ok:true, row: rs.results?.[0]||null });
    });
}

registerBacktestRoutes();
