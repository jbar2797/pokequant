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

// Baseline security headers (defense-in-depth). Applied to all JSON responses and common plain responses.
// CSP kept restrictive for API (no body scripts). Adjust if embedding HTML UI responses later.
export const SECURITY_HEADERS: Record<string,string> = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
	// Minimal CSP: disallow everything by default (APIs return JSON). If HTML endpoints added, refine.
	'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};

export function json(data: unknown, status = 200, opts?: JsonResponseOptions) {
	const ctx = currentCtx();
	const rid = ctx?.corrId;
	const headers = { 'content-type': 'application/json; charset=utf-8', ...CORS, ...SECURITY_HEADERS, ...(opts?.headers||{}) } as Record<string,string>;
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
