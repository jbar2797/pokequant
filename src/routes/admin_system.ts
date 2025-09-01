import type { Env } from '../lib/types';
import { respondJson, isAdminAuthorized } from '../lib/http_runtime';
import { APP_VERSION, BUILD_COMMIT } from '../version';
import { listMigrations } from '../migrations';
import { ErrorCodes } from '../lib/errors';
import { purgeOldData } from '../lib/retention';
import { incMetricBy, recordLatency } from '../lib/metrics';
import { audit } from '../lib/audit';
import { snapshotPortfolioFactorExposure } from '../lib/portfolio_exposure';
import { computeIntegritySnapshot } from '../lib/integrity';

// Handler tries each known admin system route; returns Response or null if not matched
export async function handleAdminSystem(req: Request, env: Env, url: URL): Promise<Response|null> {
  // Version
  if (url.pathname === '/admin/version' && req.method === 'GET') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error:'forbidden' },403);
    return respondJson({ ok:true, version: APP_VERSION, build_commit: BUILD_COMMIT || (env as any).BUILD_COMMIT || undefined });
  }
  // Migrations list
  if (url.pathname === '/admin/migrations' && req.method === 'GET') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const rows = await listMigrations(env.DB);
    return respondJson({ ok:true, rows });
  }
  // Retention purge
  if (url.pathname === '/admin/retention' && req.method === 'POST') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    let overrides: Record<string, number>|undefined;
    try {
      const body: any = await req.json().catch(()=> ({}));
      if (body && typeof body === 'object' && body.windows && typeof body.windows === 'object') {
        overrides = {};
        for (const [k,v] of Object.entries(body.windows)) {
          const days = Number(v);
            if (Number.isFinite(days) && days >= 0 && days <= 365) overrides[k] = Math.floor(days);
        }
      }
    } catch { /* ignore */ }
    const t0r = Date.now();
    const deleted = await purgeOldData(env, overrides);
    const dur = Date.now() - t0r;
    await audit(env, { actor_type:'admin', action:'purge', resource:'retention', resource_id:null, details: { deleted, ms: dur, overrides } });
    for (const [table, n] of Object.entries(deleted)) {
      if (n>0) incMetricBy(env, `retention.deleted.${table}`, n); // async fire-and-forget
    }
    recordLatency(env, 'job.retention', dur);
    return respondJson({ ok:true, deleted, ms: dur, overrides: overrides && Object.keys(overrides).length ? overrides : undefined });
  }
  // Integrity snapshot
  if (url.pathname === '/admin/integrity' && req.method === 'GET') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error:'forbidden' },403);
    try { return respondJson(await computeIntegritySnapshot(env)); } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  // Pipeline runs list
  if (url.pathname === '/admin/pipeline/runs' && req.method === 'GET') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, status TEXT, error TEXT, metrics JSON);`).run();
      const rs = await env.DB.prepare(`SELECT id, started_at, completed_at, status, error FROM pipeline_runs ORDER BY started_at DESC LIMIT 20`).all();
      return respondJson({ ok:true, rows: rs.results||[] });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  // Test insert helper
  if (url.pathname === '/admin/test-insert' && req.method === 'POST') {
  if (req.headers.get('x-admin-token') !== (env as any).ADMIN_TOKEN) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const body: any = await req.json().catch(()=>({}));
    const table = (body.table||'').toString();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const allow = new Set(['signal_components_daily','factor_returns','portfolio_nav','portfolio_factor_exposure','factor_ic','anomalies','cards','prices_daily']);
    if (!allow.has(table)) return respondJson({ ok:false, error:'table_not_allowed' },400);
    if (!rows.length) return respondJson({ ok:false, error:'no_rows' },400);
    for (const r of rows) {
      const cols = Object.keys(r).filter(k=> /^[a-zA-Z0-9_]+$/.test(k));
      if (!cols.length) continue;
      const placeholders = cols.map(()=> '?').join(',');
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
      const stmt = env.DB.prepare(sql).bind(...cols.map(c=> (r as any)[c]));
      await stmt.run();
    }
    return respondJson({ ok:true, inserted: rows.length, table });
  }
  // Portfolio factor exposure snapshot
  if (url.pathname === '/admin/portfolio-exposure/snapshot' && req.method === 'POST') {
    if (req.headers.get('x-admin-token') !== (env as any).ADMIN_TOKEN) return respondJson({ ok:false, error:'forbidden' },403);
    await snapshotPortfolioFactorExposure(env);
    return respondJson({ ok:true });
  }
  // Factor config CRUD
  if (url.pathname === '/admin/factors' && req.method === 'GET') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
    const rs = await env.DB.prepare(`SELECT factor, enabled, display_name, created_at FROM factor_config ORDER BY factor ASC`).all();
    return respondJson({ ok:true, rows: rs.results||[] });
  }
  if (url.pathname === '/admin/factors' && req.method === 'POST') {
  if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const body: any = await req.json().catch(()=>({}));
    const factor = (body.factor||'').toString().trim();
    const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
    const display = body.display_name ? String(body.display_name).trim() : null;
    if (!factor || !/^[-_a-zA-Z0-9]{2,32}$/.test(factor)) return respondJson({ ok:false, error:'invalid_factor' },400);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO factor_config (factor, enabled, display_name, created_at) VALUES (?,?,?, COALESCE((SELECT created_at FROM factor_config WHERE factor=?), datetime('now')))`) .bind(factor, enabled, display, factor).run();
    await audit(env, { actor_type:'admin', action:'upsert', resource:'factor_config', resource_id:factor, details:{ enabled } });
    return respondJson({ ok:true, factor, enabled, display_name: display });
  }
  return null; // not matched
}
