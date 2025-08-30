// Structured logging helper (console JSON lines). Disable by setting LOG_ENABLED=0.
export function log(event: string, fields: Record<string, unknown> = {}) {
	if ((globalThis as any).__LOG_DISABLED) return;
	try {
		// Include iso timestamp + event + user fields
		console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
	} catch {/* noop */}
}

