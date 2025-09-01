import { router, routeSlug, invalidateSLOCache } from '../router';
import type { Env } from '../lib/types';
import { json, err } from '../lib/http';
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
  // Heuristic SLO recommendation endpoint: inspects current-day latency p95 and breach ratios
  // to suggest a tighter or looser threshold. Strategy:
  //  - If breach ratio > 0.15 => raise threshold to max(current, ceil(p95*1.3)) (capped 30000)
  //  - If breach ratio between 0.05–0.15 => keep (unless p95 >> threshold*1.1 then bump 10%)
  //  - If breach ratio < 0.02 and p95 < threshold*0.8 => tighten to max(ceil(p95*1.05),50)
  //  - Otherwise leave unchanged.
  // Returns per-route objects: { route, current_threshold_ms, p95_ms, breach_ratio, suggested_threshold_ms, action, rationale }
  router.add('GET','/admin/slo/recommend', async ({ env, req }) => {
    await ensureSLOTable(env);
    // Latency view for p95 and config for current threshold
    let latency: any[] = [];
    try { const lrs = await env.DB.prepare(`SELECT base_metric, p95_ms FROM metrics_latency WHERE d=date('now') AND base_metric LIKE 'lat_route_%'`).all(); latency = lrs.results||[]; } catch {/* ignore */}
    // Build current threshold map
    const cfgRs = await env.DB.prepare(`SELECT route, threshold_ms FROM slo_config`).all().catch(()=>({ results:[] } as any));
    const cfg: Record<string, number> = {};
    for (const r of (cfgRs.results||[]) as any[]) cfg[String(r.route)] = Number(r.threshold_ms)||250;
    // Pull breach counters (good+breach) from metrics_daily (today)
    const metrics = await env.DB.prepare(`SELECT metric,count FROM metrics_daily WHERE d=date('now') AND metric LIKE 'req.slo.route.%'`).all().catch(()=>({results:[]} as any));
    const sloCounts: Record<string,{ good:number; breach:number }> = {};
    for (const m of (metrics.results||[]) as any[]) {
      const name = String(m.metric);
      const parts = name.split('.');
      if (parts.length < 5) continue;
      const slug = parts.slice(3, parts.length-1).join('.');
      const kind = parts[parts.length-1];
      const entry = (sloCounts[slug] ||= { good:0, breach:0 });
      if (kind === 'good') entry.good += Number(m.count)||0; else if (kind === 'breach') entry.breach += Number(m.count)||0;
    }
    const rows: any[] = [];
    // Normalize latency base_metric naming to route slug used in router (lat.route.<slug>) -> metrics_latency base_metric is lat_route_<slug>
    const p95Map: Record<string, number> = {};
    for (const l of latency as any[]) {
      const base = String(l.base_metric||'');
      if (!base.startsWith('lat_route_')) continue;
      const slug = base.substring('lat_route_'.length);
      p95Map[slug] = Number(l.p95_ms)||0;
    }
    // Union of routes with config, latency, or counts
    const routeSlugs = new Set<string>([...Object.keys(cfg), ...Object.keys(p95Map), ...Object.keys(sloCounts)]);
    for (const slug of routeSlugs) {
      const p95 = p95Map[slug];
      const counts = sloCounts[slug] || { good:0, breach:0 };
      const denom = counts.good + counts.breach;
      const ratio = denom ? counts.breach/denom : 0;
      const current = cfg[slug] || 250;
      let suggested = current;
      let action = 'keep';
      let rationale = 'stable';
      if (ratio > 0.15) {
        suggested = Math.min(30000, Math.max(current, Math.ceil((p95||current)*1.3)));
        if (suggested !== current) { action='raise'; rationale = 'high_breach_ratio'; }
      } else if (ratio < 0.02 && p95 && p95 < current*0.8) {
        suggested = Math.max(50, Math.ceil(p95*1.05));
        if (suggested < current) { action='tighten'; rationale='low_breach_and_headroom'; }
      } else if (ratio >= 0.05 && ratio <= 0.15) {
        if (p95 > current*1.1) { suggested = Math.min(30000, Math.ceil(current*1.1)); action='raise'; rationale='moderate_breach_and_p95_near_threshold'; }
      }
      rows.push({ route: slug, current_threshold_ms: current, p95_ms: p95||null, breach_ratio: +ratio.toFixed(4), suggested_threshold_ms: suggested, action, rationale });
    }
    rows.sort((a,b)=> a.route.localeCompare(b.route));
    return json({ ok:true, rows, generated_at: new Date().toISOString() });
  });

router.add('POST','/admin/slo/set', async ({ env, req }) => {
  if (!adminAuth(env, req)) return json({ ok:false, error:ErrorCodes.Forbidden },403);
  const body: any = await req.json().catch(()=>({}));
  let route = (body.route||body.path||'').toString();
  if (!route) return err(ErrorCodes.RouteRequired,400);
  if (route.startsWith('/')) route = routeSlug(route);
  if (!/^[a-zA-Z0-9_]+$/.test(route)) return err(ErrorCodes.InvalidRoute,400);
  const ms = Number(body.threshold_ms||body.ms||body.threshold);
  if (!Number.isFinite(ms) || ms < 10 || ms > 30000) return err(ErrorCodes.InvalidThreshold,400);
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
