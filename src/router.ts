// Lightweight router abstraction for Cloudflare Worker
import type { Env } from './lib/types';
import { recordLatency, incMetric } from './lib/metrics';
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
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, dur);
      try {
        await incMetric(env, 'req.total');
        await incMetric(env, `req.status.${Math.floor(resp.status/100)}xx`);
        if (resp.status >= 500) await incMetric(env, 'request.error.5xx');
        else if (resp.status >= 400) await incMetric(env, 'request.error.4xx');
      } catch {/* metric errors ignored */}
      return resp;
    } catch (e:any) {
      log('route_error', { path: url.pathname, error:String(e) });
      const dur = Date.now() - t0;
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, dur);
      try { await incMetric(env, 'req.total'); await incMetric(env, 'req.status.5xx'); await incMetric(env, 'request.error.5xx'); } catch {}
      return new Response('Internal Error', { status:500 });
    }
  }
}

export const router = new Router();
