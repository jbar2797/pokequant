// Lightweight router abstraction for Cloudflare Worker
import type { Env } from './lib/types';

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
    return r.handler({ req, env, url });
  }
}

export const router = new Router();
