import type { JsonResponseOptions } from './types';

export const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'content-type, x-ingest-token, x-admin-token, x-portfolio-id, x-portfolio-secret, x-manage-token',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

export function json(data: unknown, status = 200, opts?: JsonResponseOptions) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...(opts?.headers||{}) }
	});
}

export function err(code: string, status = 400, extra: Record<string, unknown> = {}) {
	return json({ ok:false, error: code, ...extra }, status);
}
