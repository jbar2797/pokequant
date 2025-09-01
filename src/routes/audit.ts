import { router } from '../router';
import { json } from '../lib/http';
import type { Env } from '../lib/types';
import { audit as auditLog } from '../lib/audit';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerAuditRoutes() {
  router
    .add('GET','/admin/audit', async ({ env, req, url }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const resource = (url.searchParams.get('resource')||'').trim();
      const action = (url.searchParams.get('action')||'').trim();
      const actorType = (url.searchParams.get('actor_type')||'').trim();
      const resourceId = (url.searchParams.get('resource_id')||'').trim();
      const beforeTs = (url.searchParams.get('before_ts')||'').trim();
      let limit = parseInt(url.searchParams.get('limit')||'200',10); if (!Number.isFinite(limit)||limit<1) limit=100; if (limit>500) limit=500;
      const where:string[]=[]; const binds:any[]=[];
      if (resource) { where.push('resource=?'); binds.push(resource); }
      if (action) { where.push('action=?'); binds.push(action); }
      if (actorType) { where.push('actor_type=?'); binds.push(actorType); }
      if (resourceId) { where.push('resource_id=?'); binds.push(resourceId); }
      if (beforeTs) { where.push('ts < ?'); binds.push(beforeTs); }
      const sql = `SELECT id, ts, actor_type, actor_id, action, resource, resource_id, details FROM mutation_audit ${where.length? 'WHERE '+where.join(' AND '):''} ORDER BY ts DESC LIMIT ?`;
      binds.push(limit);
      try { const rs = await env.DB.prepare(sql).bind(...binds).all(); const rows = (rs.results||[]) as any[]; const next = rows.length===limit ? rows[rows.length-1].ts : null; return json({ ok:true, rows, page:{ next_before_ts: next }, filtered:{ resource:resource||undefined, action:action||undefined, actor_type:actorType||undefined, resource_id:resourceId||undefined, limit, before_ts: beforeTs||undefined } }); } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('GET','/admin/audit/stats', async ({ env, req, url }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const hours = Math.min(168, Math.max(1, parseInt(url.searchParams.get('hours')||'24',10)));
      try { const cutoff = new Date(Date.now() - hours*3600*1000).toISOString(); const rs = await env.DB.prepare(`SELECT action, resource, COUNT(*) AS n FROM mutation_audit WHERE ts >= ? GROUP BY action, resource ORDER BY n DESC LIMIT 100`).bind(cutoff).all(); const totals = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit WHERE ts >= ?`).bind(cutoff).all(); return json({ ok:true, hours, total: totals.results?.[0]?.n||0, rows: rs.results||[] }); } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('POST','/admin/test-audit', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
      auditLog(env, { actor_type: body.actor_type||'test', action: body.action||'emit', resource: body.resource||'test_event', resource_id: body.resource_id||null, details: body.details });
      return json({ ok:true });
    });
}

registerAuditRoutes();
