import { router } from '../router';
import { json } from '../lib/http';
import type { Env } from '../lib/types';
import { audit } from '../lib/audit';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerAnomaliesRoutes() {
  router
    .add('GET','/admin/anomalies', async ({ env, req, url }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const status = (url.searchParams.get('status')||'').toLowerCase();
      let limit = parseInt(url.searchParams.get('limit')||'100',10); if (!Number.isFinite(limit) || limit<1) limit=50; if (limit>200) limit=200;
      const before = url.searchParams.get('before_created_at') || '';
      const whereParts: string[] = [];
      if (status === 'resolved') whereParts.push('resolved=1');
      else if (status === 'open') whereParts.push('COALESCE(resolved,0)=0');
      if (before) whereParts.push('created_at < ?');
      const whereSql = whereParts.length ? ('WHERE '+ whereParts.join(' AND ')) : '';
      const binds: any[] = []; if (before) binds.push(before);
      const sql = `SELECT id, as_of, card_id, kind, magnitude, created_at, resolved, resolution_kind, resolution_note, resolved_at FROM anomalies ${whereSql} ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);
      const rs = await env.DB.prepare(sql).bind(...binds).all();
      const rows = (rs.results||[]) as any[];
      const next = rows.length === limit ? rows[rows.length-1].created_at : null;
      return json({ ok:true, rows, page: { next_before_created_at: next }, filtered: { status: status||undefined, limit, before_created_at: before||undefined } });
    })
    .add('POST','/admin/anomalies/resolve', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const id = (body.id||'').toString();
      const action = (body.action||'ack').toString();
      const note = body.note ? String(body.note).slice(0,200) : null;
      if (!id) return json({ ok:false, error:'id_required' },400);
      const valid = new Set(['ack','dismiss','ignore']);
      if (!valid.has(action)) return json({ ok:false, error:'invalid_action' },400);
      await env.DB.prepare(`UPDATE anomalies SET resolved=1, resolution_kind=?, resolution_note=?, resolved_at=datetime('now') WHERE id=?`).bind(action, note, id).run();
      await audit(env, { actor_type:'admin', action:'resolve', resource:'anomaly', resource_id:id, details:{ action } });
      return json({ ok:true, id, action });
    });
}

registerAnomaliesRoutes();
