import type { JsonResponseOptions, Env } from './types';
import { incMetric } from './metrics';
import { log } from './log';

function currentCtx(): { corrId?: string; env?: Env } | undefined {
	try { return (globalThis as any).__REQ_CTX; } catch { return undefined; }
}

export const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token, x-request-id',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

export function json(data: unknown, status = 200, opts?: JsonResponseOptions) {
	const ctx = currentCtx();
	const rid = ctx?.corrId;
	const headers = { 'content-type': 'application/json; charset=utf-8', ...CORS, ...(opts?.headers||{}) } as Record<string,string>;
	if (rid && !headers['x-request-id']) headers['x-request-id'] = rid;
	return new Response(JSON.stringify(data), { status, headers });
}

export function err(code: string, status = 400, extra: Record<string, unknown> = {}) {
	// Fire-and-forget metric increments (ignore failures). Metric naming: error.CODE and error_status.STATUS.
	try {
		const ctx = currentCtx();
		if (ctx?.env) {
			// Aggregate by code and status family
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			incMetric(ctx.env, `error.${code}`);
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			incMetric(ctx.env, `error_status.${status}`);
			// Optional structured logging (once per request) when API_ERROR_LOG=1
			try {
				if ((ctx.env as any).API_ERROR_LOG === '1' && !(ctx as any).__err_logged) {
					log('api_error', { code, status });
					(ctx as any).__err_logged = true;
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	return json({ ok:false, error: code, ...extra }, status);
}
