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
      const where = status === 'resolved' ? 'WHERE resolved=1' : status === 'open' ? 'WHERE COALESCE(resolved,0)=0' : '';
      const rs = await env.DB.prepare(`SELECT id, as_of, card_id, kind, magnitude, created_at, resolved, resolution_kind, resolution_note, resolved_at FROM anomalies ${where} ORDER BY created_at DESC LIMIT 200`).all();
      return json({ ok:true, rows: rs.results||[] });
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
