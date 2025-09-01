import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import type { Env } from '../lib/types';
import { computeIntegritySnapshot } from '../lib/integrity';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerSnapshotRoutes() {
  router.add('GET','/admin/snapshot', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
    const [integrity, ic, weights] = await Promise.all([
      computeIntegritySnapshot(env),
      env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic ORDER BY as_of DESC, factor ASC LIMIT 30`).all(),
      env.DB.prepare(`SELECT version, factor, weight, active FROM factor_weights WHERE active=1`).all()
    ]);
    const factorReturns = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns ORDER BY as_of DESC, factor ASC LIMIT 60`).all();
    return json({ ok:true, integrity, factor_ic: (ic as any).results||[], active_weights: (weights as any).results||[], factor_returns: (factorReturns.results||[]) });
  });
}

registerSnapshotRoutes();
