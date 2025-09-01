// HTTP runtime scaffolding (Phase 1 extraction) – minimal helpers without behavior change yet.
// Future phases: per-route metrics, standardized error mapping, validation integration.
import type { Env } from './types';
import { incMetric, incMetricBy, recordLatency } from './metrics';
import { log } from './log';

export interface RequestContext {
  req: Request;
  env: Env;
}

// Lightweight JSON response helper (mirrors inline json() helper in index.ts)
export function respondJson(data: any, status = 200, headers?: Record<string,string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json; charset=utf-8', ...(headers||{}) } });
}

// Admin auth gate (dual token support). Returns boolean; caller decides response.
export async function isAdminAuthorized(req: Request, env: Env): Promise<boolean> {
  const at = req.headers.get('x-admin-token');
  if (!at) return false;
  const ok = (at === (env as any).ADMIN_TOKEN) || ((env as any).ADMIN_TOKEN_NEXT && at === (env as any).ADMIN_TOKEN_NEXT);
  // Opportunistically record usage (hashed/fingerprinted) without blocking request
  if (ok) {
    try {
      const fp = await fingerprintToken(at);
      // fire and forget; ignore errors
      env.DB.prepare(`INSERT INTO admin_token_usage (fingerprint, count, last_used_at) VALUES (?,1,datetime('now'))
        ON CONFLICT(fingerprint) DO UPDATE SET count=count+1, last_used_at=datetime('now')`).bind(fp).run();
    } catch {/* ignore */}
  }
  return !!ok;
}

// Lightweight SHA-256 hex fingerprint (not cryptographically secret inside runtime but avoids storing raw token)
async function fingerprintToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b=> b.toString(16).padStart(2,'0')).join('').slice(0,32); // truncate to 128-bit hex for brevity
}

// Placeholder route wrapper for future metric instrumentation.
export interface RouteResult { response: Response; ms: number }

// Wraps a route handler capturing duration (no per-route metrics yet; added next sprint phase)
export async function runRoute(name: string, ctx: RequestContext, handler: (ctx: RequestContext) => Promise<Response>): Promise<RouteResult> {
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await handler(ctx);
  } catch (e:any) {
    await incMetric(ctx.env, 'req.status.5xx');
    log('route_error', { route: name, error: String(e) });
    resp = new Response('internal error', { status: 500, headers: { 'content-type':'text/plain' } });
  }
  const ms = Date.now() - t0;
  try {
    await recordLatency(ctx.env, `lat.route.${name}`, ms);
    const bucket = ms < 50 ? 'lt50' : ms < 100 ? 'lt100' : ms < 250 ? 'lt250' : ms < 500 ? 'lt500' : ms < 1000 ? 'lt1000' : 'gte1000';
    await incMetric(ctx.env, `latbucket.route.${name}.${bucket}`);
  } catch {/* swallow */}
  return { response: resp, ms };
}

// Request-level finalizer for top-level handler (mirrors previous inline done())
export async function finalizeRequest(env: Env, url: URL, tag: string, t0: number, resp: Response): Promise<Response> {
  const ms = Date.now() - t0;
  try { log('req_timing', { path: url.pathname, tag, ms, status: resp.status }); } catch {}
  try {
    await recordLatency(env, `lat.${tag}`, ms);
    const bucket = ms < 50 ? 'lt50' : ms < 100 ? 'lt100' : ms < 250 ? 'lt250' : ms < 500 ? 'lt500' : ms < 1000 ? 'lt1000' : 'gte1000';
    await incMetric(env, `latbucket.${tag}.${bucket}`);
    await incMetric(env, 'req.total');
    await incMetric(env, `req.status.${Math.floor(resp.status/100)}xx`);
    if (resp.status >= 500) await incMetric(env, 'request.error.5xx');
    else if (resp.status >= 400) await incMetric(env, 'request.error.4xx');
  } catch {/* ignore metrics errors */}
  return resp;
}

