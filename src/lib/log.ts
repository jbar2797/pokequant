// Structured logging helper (console JSON lines). Disable by setting LOG_ENABLED=0.
// Automatically attaches correlation/request id when present (set in request handler).
export function log(event: string, fields: Record<string, unknown> = {}) {
	if ((globalThis as any).__LOG_DISABLED) return;
	try {
		const ctx = (globalThis as any).__REQ_CTX;
		const base: Record<string, unknown> = { t: new Date().toISOString(), event };
		if (ctx?.corrId) base.request_id = ctx.corrId;
		console.log(JSON.stringify({ ...base, ...fields }));
	} catch {/* noop */}
}

// Lightweight helper to set current request context (called once at request start).
export function setRequestContext(corrId: string, env?: unknown) {
	(globalThis as any).__REQ_CTX = { corrId, env };
}

