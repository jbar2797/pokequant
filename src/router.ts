// Lightweight router abstraction for Cloudflare Worker
import type { Env } from './lib/types';
import { recordLatency, incMetric } from './lib/metrics';
import { setMetric } from './lib/metrics';
import { log } from './lib/log';

export interface RouteContext {
  req: Request;
  env: Env;
  url: URL;
}
export type Handler = (ctx: RouteContext) => Promise<Response> | Response;
export interface RouteDef { method: string; path: string; handler: Handler; }

export class Router {
  private routes: RouteDef[] = [];
  add(method: string, path: string, handler: Handler) { this.routes.push({ method: method.toUpperCase(), path, handler }); return this; }
  match(method: string, pathname: string): RouteDef | undefined {
    return this.routes.find(r => r.method === method.toUpperCase() && r.path === pathname);
  }
  async handle(req: Request, env: Env): Promise<Response | undefined> {
    const url = new URL(req.url);
    const r = this.match(req.method, url.pathname);
    if (!r) return undefined;
    const t0 = Date.now();
    try {
  const resp = await r.handler({ req, env, url });
  const dur = Date.now() - t0;
      // Back-compat latency metric (existing dashboards may depend on path-based name)
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, dur);
  // New normalized per-route metrics
  const slug = routeSlug(url.pathname);
  let sloRatio: number | undefined = undefined; // hoisted for later context enrichment
  let sloGood: boolean | undefined = undefined; // hoisted for later context enrichment
  // Fetch dynamic SLO threshold (default 250ms) before metrics classification
  const sloMs = await getSLOThreshold(env, slug).catch(()=>250);
      await recordLatency(env, `lat.route.${slug}`, dur);
      try {
        await incMetric(env, 'req.total');
        await incMetric(env, `req.status.${Math.floor(resp.status/100)}xx`);
        await incMetric(env, `req.route.${slug}`);
        if (resp.status >= 500) await incMetric(env, 'request.error.5xx');
        else if (resp.status >= 400) await incMetric(env, 'request.error.4xx');
        // Latency bucket histogram (mirrors legacy done() logic)
        const bucket = dur < 50 ? 'lt50' : dur < 100 ? 'lt100' : dur < 250 ? 'lt250' : dur < 500 ? 'lt500' : dur < 1000 ? 'lt1000' : 'gte1000';
        await incMetric(env, `latbucket.route.${slug}.${bucket}`);
  // Dynamic SLO classification: good if latency under threshold AND status <500
  sloGood = dur < sloMs && resp.status < 500;
  await incMetric(env, `req.slo.route.${slug}.${sloGood? 'good':'breach'}`);
  // Update rolling breach ratio in-memory (window of last 100 events per route) and persist per-minute counters
  const breachFlag = sloGood ? 0 : 1;
  updateSLOBreachWindow(slug, breachFlag);
  recordSLOBreachMinute(env, slug, breachFlag);
  sloRatio = computeSLOBreachRatio(slug);
  if (sloRatio >= 0) { try { await setMetric(env, `slo.breach_ratio.route.${slug}`, Math.round(sloRatio*1000)); } catch {/* ignore */} }
      } catch {/* ignore metric errors */}
      try {
        // path-based bucket for legacy (optional)
        const bucket = dur < 50 ? 'lt50' : dur < 100 ? 'lt100' : dur < 250 ? 'lt250' : dur < 500 ? 'lt500' : dur < 1000 ? 'lt1000' : 'gte1000';
        await incMetric(env, `latbucket.${tagBase.substring(4)}.${bucket}`);
      } catch {/* metric errors ignored */}
      try {
  const ctx:any = (globalThis as any).__REQ_CTX || ((globalThis as any).__REQ_CTX = {});
  ctx.routeSlug = slug; ctx.status = resp.status; ctx.latency_ms = dur; ctx.slo_threshold_ms = sloMs; ctx.slo_class = typeof sloGood === 'boolean' ? (sloGood ? 'good':'breach') : undefined; ctx.slo_breach_ratio = (sloRatio !== undefined && sloRatio >=0) ? sloRatio : undefined;
      } catch {/* ignore */}
      return resp;
    } catch (e:any) {
      log('route_error', { path: url.pathname, error:String(e) });
      const dur = Date.now() - t0;
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, dur);
      const slug = routeSlug(url.pathname);
      const sloMs = await getSLOThreshold(env, slug).catch(()=>250);
      await recordLatency(env, `lat.route.${slug}`, dur);
      try {
        await incMetric(env, 'req.total');
        await incMetric(env, 'req.status.5xx');
        await incMetric(env, 'request.error.5xx');
        await incMetric(env, `req.route.${slug}`);
        const bucket = dur < 50 ? 'lt50' : dur < 100 ? 'lt100' : dur < 250 ? 'lt250' : dur < 500 ? 'lt500' : dur < 1000 ? 'lt1000' : 'gte1000';
        await incMetric(env, `latbucket.route.${slug}.${bucket}`);
        await incMetric(env, `latbucket.${tagBase.substring(4)}.${bucket}`);
        // Always a breach on error if we have a threshold
  await incMetric(env, `req.slo.route.${slug}.breach`);
  updateSLOBreachWindow(slug, 1);
  recordSLOBreachMinute(env, slug, 1);
  const sloRatio2 = computeSLOBreachRatio(slug);
  if (sloRatio2 >= 0) { try { await setMetric(env, `slo.breach_ratio.route.${slug}`, Math.round(sloRatio2*1000)); } catch {/* ignore */} }
      } catch {/* ignore */}
      return new Response('Internal Error', { status:500 });
    }
  }
}

// Derive a stable slug for a route path (no dynamic segments in current codebase yet)
export function routeSlug(path: string): string {
  if (path === '/' || path === '') return 'root';
  // Remove leading slash, replace non-alphanumerics with underscore, collapse repeats
  return path.replace(/^\//,'').replace(/[^a-zA-Z0-9]+/g,'_').replace(/_+/g,'_').replace(/_$/,'') || 'root';
}

export const router = new Router();

// ---------------- Dynamic SLO configuration (per-route thresholds) ----------------
// Backed by lightweight table slo_config(route TEXT PRIMARY KEY, threshold_ms INTEGER, updated_at TEXT)
// Cached in-memory with short TTL to avoid per-request DB lookups.
interface SLOCacheEntry { ms: number; fetched: number; }
const SLO_CACHE: Record<string, SLOCacheEntry> = Object.create(null);
const SLO_TTL_MS = 30_000; // 30s cache TTL
const SLO_DEFAULT_MS = 250;

async function ensureSLOTable(env: Env) {
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_config (route TEXT PRIMARY KEY, threshold_ms INTEGER NOT NULL, updated_at TEXT)` ).run(); } catch {/* ignore */}
}

async function fetchSLO(env: Env, slug: string): Promise<number|undefined> {
  await ensureSLOTable(env);
  try {
    const rs = await env.DB.prepare(`SELECT threshold_ms FROM slo_config WHERE route=?`).bind(slug).all();
    const v = Number(rs.results?.[0]?.threshold_ms);
    return Number.isFinite(v) ? v : undefined;
  } catch { return undefined; }
}

async function getSLOThreshold(env: Env, slug: string): Promise<number> {
  const now = Date.now();
  const entry = SLO_CACHE[slug];
  if (entry && (now - entry.fetched) < SLO_TTL_MS) return entry.ms;
  const v = await fetchSLO(env, slug);
  const ms = (v && v >= 10 && v <= 30_000) ? v : SLO_DEFAULT_MS;
  SLO_CACHE[slug] = { ms, fetched: now };
  return ms;
}

// Invalidate SLO cache for a specific route slug (or all if none provided)
export function invalidateSLOCache(slug?: string) {
  if (slug) {
    delete SLO_CACHE[slug];
  } else {
    for (const k of Object.keys(SLO_CACHE)) delete SLO_CACHE[k];
  }
}

// ---------------- Rolling SLO breach ratio tracking ----------------
// Maintain last N (100) classification outcomes per route (0=good,1=breach) and compute breach/(total)
// Exported for observability endpoint (/admin/slo/windows) and tests. Contains rolling
// breach classification windows per route. Internal mutation only via updateSLOBreachWindow.
export const SLO_WINDOWS: Record<string, number[]> = Object.create(null);
const SLO_WINDOW_MAX = 100;
function updateSLOBreachWindow(slug: string, breachFlag: number) {
  let arr = SLO_WINDOWS[slug];
  if (!arr) { arr = []; SLO_WINDOWS[slug] = arr; }
  arr.push(breachFlag ? 1 : 0);
  if (arr.length > SLO_WINDOW_MAX) arr.splice(0, arr.length - SLO_WINDOW_MAX);
}
function computeSLOBreachRatio(slug: string): number {
  const arr = SLO_WINDOWS[slug];
  if (!arr || !arr.length) return -1;
  const breaches = arr.reduce((a,b)=> a + (b?1:0), 0);
  return breaches / arr.length;
}

// Persist rolling counts per route per minute to survive restarts (approximation for short-window burn)
async function recordSLOBreachMinute(env: Env, slug: string, breachFlag: number) {
  const minute = new Date().toISOString().slice(0,16).replace(/[-:T]/g,'').slice(0,12); // YYYYMMDDHHMM
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_breach_minute (route TEXT NOT NULL, minute TEXT NOT NULL, total INTEGER NOT NULL, breach INTEGER NOT NULL, PRIMARY KEY(route, minute));`).run();
    await env.DB.prepare(`INSERT INTO slo_breach_minute (route, minute, total, breach) VALUES (?,?,1,?) ON CONFLICT(route,minute) DO UPDATE SET total=total+1, breach=breach + excluded.breach`).bind(slug, minute, breachFlag?1:0).run();
  } catch {/* ignore */}
}
