// Lightweight router abstraction for Cloudflare Worker
import type { Env } from './lib/types';
import { recordLatency } from './lib/metrics';
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
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, Date.now() - t0); // ensure DB write completes before returning
      return resp;
    } catch (e:any) {
      log('route_error', { path: url.pathname, error:String(e) });
      const tagBase = 'lat' + url.pathname.replace(/\//g, '.');
      await recordLatency(env, tagBase, Date.now() - t0);
      return new Response('Internal Error', { status:500 });
    }
  }
}

export const router = new Router();
