import { router, routeSlug } from '../router';
import type { Env } from '../lib/types';
import { json } from '../lib/http';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

// Test helper: artificial latency route for deterministic SLO breach testing.
router.add('GET','/admin/test/sleep', async ({ env, req, url }) => {
  if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
  let ms = parseInt(url.searchParams.get('ms')||'50',10);
  if (!Number.isFinite(ms) || ms < 0) ms = 0; if (ms > 500) ms = 500; // cap
  if (ms > 0) await new Promise(r=> setTimeout(r, ms));
  return json({ ok:true, slept_ms: ms, slug: routeSlug('/admin/test/sleep') });
});

// Test helper: insert or upsert a metric row for a specific historical day in metrics_daily.
router.add('POST','/admin/test/metric/insert', async ({ env, req }) => {
  if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
  const body:any = await req.json().catch(()=>({}));
  const d = (body.d||'').toString();
  const metric = (body.metric||'').toString();
  const count = Number(body.count||1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ ok:false, error:'invalid_date' },400);
  if (!metric) return json({ ok:false, error:'metric_required' },400);
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run(); } catch {}
  await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count=?`).bind(d, metric, Math.max(0, Math.floor(count)), Math.max(0, Math.floor(count))).run();
  return json({ ok:true, d, metric, count: Math.max(0, Math.floor(count)) });
});

// Test helper: check if metric exists for day.
router.add('GET','/admin/test/metric/exists', async ({ env, req, url }) => {
  if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
  const d = (url.searchParams.get('d')||'').toString();
  const metric = (url.searchParams.get('metric')||'').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !metric) return json({ ok:false, error:'invalid_params' },400);
  try { const rs = await env.DB.prepare(`SELECT count FROM metrics_daily WHERE d=? AND metric=?`).bind(d, metric).all(); return json({ ok:true, exists: !!(rs.results && rs.results.length), count: rs.results?.[0]?.count||0 }); } catch { return json({ ok:true, exists:false }); }
});
