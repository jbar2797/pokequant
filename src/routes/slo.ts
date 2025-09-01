import { router, routeSlug, invalidateSLOCache } from '../router';
import type { Env } from '../lib/types';
import { json } from '../lib/http';
import { audit } from '../lib/audit';
import { ErrorCodes } from '../lib/errors';

function adminAuth(env: Env, req: Request) {
  const t = req.headers.get('x-admin-token');
  return !!(t && (t === env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t === env.ADMIN_TOKEN_NEXT)));
}

async function ensureSLOTable(env: Env) {
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_config (route TEXT PRIMARY KEY, threshold_ms INTEGER NOT NULL, updated_at TEXT)` ).run(); } catch {/* ignore */}
}

router.add('GET','/admin/slo', async ({ env, req }) => {
    if (!adminAuth(env, req)) return json({ ok:false, error:ErrorCodes.Forbidden },403);
  await ensureSLOTable(env);
  const rs = await env.DB.prepare(`SELECT route, threshold_ms, updated_at FROM slo_config ORDER BY route`).all();
  return json({ ok:true, rows: rs.results||[] });
});

router.add('POST','/admin/slo/set', async ({ env, req }) => {
  if (!adminAuth(env, req)) return json({ ok:false, error:ErrorCodes.Forbidden },403);
  const body: any = await req.json().catch(()=>({}));
  let route = (body.route||body.path||'').toString();
  if (!route) return json({ ok:false, error:'route_required' },400);
  if (route.startsWith('/')) route = routeSlug(route);
  if (!/^[a-zA-Z0-9_]+$/.test(route)) return json({ ok:false, error:'invalid_route' },400);
  const ms = Number(body.threshold_ms||body.ms||body.threshold);
  if (!Number.isFinite(ms) || ms < 10 || ms > 30000) return json({ ok:false, error:'invalid_threshold' },400);
  await ensureSLOTable(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO slo_config (route, threshold_ms, updated_at) VALUES (?,?,datetime('now'))`).bind(route, Math.floor(ms)).run();
  invalidateSLOCache(route);
  await audit(env, { actor_type:'admin', action:'upsert', resource:'slo_config', resource_id:route, details:{ threshold_ms: Math.floor(ms) } });
  const row = await env.DB.prepare(`SELECT route, threshold_ms, updated_at FROM slo_config WHERE route=?`).bind(route).all();
  return json({ ok:true, row: row.results?.[0]||null });
});

// Rolling SLO windows debug endpoint
router.add('GET','/admin/slo/windows', async ({ env, req }) => {
  if (!adminAuth(env, req)) return json({ ok:false, error:ErrorCodes.Forbidden },403);
  let windows: Record<string, number[]> = {};
  try { const mod = await import('../router'); windows = (mod as any).SLO_WINDOWS || {}; } catch {}
  const out: Record<string,{ samples:number; breach_ratio:number }> = {};
  for (const [slug, arr] of Object.entries(windows)) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const breaches = (arr as number[]).reduce((a,b)=> a + (b?1:0),0);
    out[slug] = { samples: (arr as number[]).length, breach_ratio: breaches / (arr as number[]).length };
  }
  return json({ ok:true, windows: out });
});
