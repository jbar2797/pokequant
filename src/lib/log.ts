// Structured logging helper (console JSON lines). Disable by setting LOG_ENABLED=0.
// Automatically attaches correlation/request id when present (set in request handler).
const RING_MAX = 200; // lightweight in-memory ring for recent logs (admin diagnostics/export)
let ring: any[] = [];
let pendingExternal: any[] = []; // buffer for external sink (flush best-effort)
let sinkStats = { flushes:0, errors:0, retries:0, last_flush_bytes:0 };
let memoryFlushes: any[][] = []; // test-only memory sink batches

async function logMetric(env:any, metric:string, delta=1){
  try {
    if(!env || !env.DB) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
    const d = new Date().toISOString().slice(0,10);
    await env.DB.prepare(`INSERT INTO metrics_daily (d,metric,count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count = count + ${Math.max(1,delta)}`).bind(d, metric, Math.max(1,delta)).run();
  } catch {/* ignore metric errors */}
}

async function flushExternal(env: any){
	if(!pendingExternal.length) return;
	const batch = pendingExternal.splice(0, pendingExternal.length);
	const mode = env && env.LOG_SINK_MODE;
	if(!(env && mode)) { return; }
	const body = batch.map(e=> JSON.stringify(e)).join('\n');
	if (mode === 'memory') {
		memoryFlushes.push(batch);
		sinkStats.flushes++; sinkStats.last_flush_bytes = body.length;
		await logMetric(env,'log.flush');
		return;
	}
	if (mode === 'r2' && (env as any).LOGS_R2) {
		const key = `logs/${new Date().toISOString().replace(/[:T]/g,'_').slice(0,19)}_${crypto.randomUUID()}.ndjson`;
		let attempt = 0; const maxAttempts = 3;
		for(;;){
			try {
				await (env as any).LOGS_R2.put(key, body, { httpMetadata:{ contentType:'application/x-ndjson' } });
				sinkStats.flushes++; sinkStats.last_flush_bytes = body.length; await logMetric(env,'log.flush');
				break;
			} catch(e){
				sinkStats.errors++; await logMetric(env,'log.flush_error');
				if(++attempt>=maxAttempts){ break; }
				sinkStats.retries++; await logMetric(env,'log.flush_retry');
				const base = 50 * Math.pow(2, attempt-1) + Math.random()*25; await new Promise(r=> setTimeout(r, base));
			}
		}
		return;
	}
	if (mode === 'http' && env.LOG_SINK_ENDPOINT) {
		let attempt=0; const maxAttempts=3; const url=env.LOG_SINK_ENDPOINT; const auth=env.LOG_SINK_AUTH;
		for(;;){
			try {
				const headers: Record<string,string> = { 'content-type':'application/x-ndjson' };
				if (auth) headers['authorization'] = auth.startsWith('Bearer ')? auth : `Bearer ${auth}`;
				const resp = await fetch(url, { method:'POST', headers, body });
				if (!resp.ok) throw new Error('http_sink_status_'+resp.status);
				sinkStats.flushes++; sinkStats.last_flush_bytes = body.length; await logMetric(env,'log.flush'); break;
			} catch(e){
				sinkStats.errors++; await logMetric(env,'log.flush_error');
				if(++attempt>=maxAttempts) break;
				sinkStats.retries++; await logMetric(env,'log.flush_retry');
				const base = 50 * Math.pow(2, attempt-1) + Math.random()*25; await new Promise(r=> setTimeout(r, base));
			}
		}
	}
}

export function log(event: string, fields: Record<string, unknown> = {}) {
	if ((globalThis as any).__LOG_DISABLED) return;
	try {
		const ctx = (globalThis as any).__REQ_CTX;
		const base: Record<string, unknown> = { t: new Date().toISOString(), event };
		// Basic redaction of sensitive field names
		for (const k of Object.keys(fields)) {
			if (/secret|token|password|apikey|auth/i.test(k)) {
				(fields as any)[k] = '[REDACTED]';
			} else {
				// If value is a plain object, shallow-scan its keys for redaction too (non-recursive)
				const v:any = (fields as any)[k];
				if (v && typeof v === 'object' && !Array.isArray(v)) {
					for (const nk of Object.keys(v)) {
						if (/secret|token|password|apikey|auth/i.test(nk)) {
							v[nk] = '[REDACTED]';
						}
					}
				}
			}
		}
		// If request context enriched with routing metadata, attach
		if (ctx?.routeSlug) base.route = ctx.routeSlug;
		if (ctx?.status) base.status = ctx.status;
		if (ctx?.latency_ms !== undefined) base.latency_ms = ctx.latency_ms;
		if (ctx?.slo_threshold_ms !== undefined) base.slo_threshold_ms = ctx.slo_threshold_ms;
		if (ctx?.slo_class) base.slo_class = ctx.slo_class; // 'good' | 'breach'
		if (ctx?.slo_breach_ratio !== undefined) base.slo_breach_ratio = ctx.slo_breach_ratio; // last rolling window ratio 0..1
		if (ctx?.corrId) base.request_id = ctx.corrId;
		const entry = { ...base, ...fields };
		console.log(JSON.stringify(entry));
		// Ring buffer capture (best-effort)
		try {
			if (ring.length >= RING_MAX) ring.shift();
			ring.push(entry);
			// External sink staging: keep small buffer (<=100) then flush
			const env = (globalThis as any).__REQ_CTX?.env;
			if(env && env.LOG_SINK_MODE){
				pendingExternal.push(entry);
				if(pendingExternal.length >= 50){
					flushExternal(env); // fire and forget
				}
			}
		} catch { /* ignore ring errors */ }
	} catch {/* noop */}
}

// Lightweight helper to set current request context (called once at request start).
export function setRequestContext(corrId: string, env?: unknown) {
	(globalThis as any).__REQ_CTX = { corrId, env };
}

// --- Test utilities (no-op in production) ---
// Allow tests to capture logs temporarily to assert on absence/presence of events
// Usage in tests: startLogCapture(); ... do stuff ... const logs = stopLogCapture(); expect(!logs.some(l=> l.event==='metric_latency_error'))
export function startLogCapture() {
	const g:any = globalThis as any;
	if (g.__LOG_CAPTURE_ACTIVE) return; // already capturing
	g.__LOG_CAPTURE_ACTIVE = true;
	g.__LOG_CAPTURED = [];
	const orig = console.log;
	g.__LOG_ORIG = orig;
	console.log = function(this: unknown, ...args: any[]) {
		try {
			if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
				try { const parsed = JSON.parse(args[0]); if (g.__LOG_CAPTURE_ACTIVE) g.__LOG_CAPTURED.push(parsed); } catch {/* ignore parse */}
			}
		} catch {/* ignore */}
		return (orig as any).apply(this, args as any);
	} as any;
}

export function stopLogCapture(): any[] {
	const g:any = globalThis as any;
	if (!g.__LOG_CAPTURE_ACTIVE) return [];
	g.__LOG_CAPTURE_ACTIVE = false;
	if (g.__LOG_ORIG) console.log = g.__LOG_ORIG;
	const logs = g.__LOG_CAPTURED || [];
	g.__LOG_CAPTURED = [];
	return logs;
}

// Expose recent ring for admin endpoint (read-only copy)
export function recentLogs(limit = 100): any[] {
	try { return ring.slice(-Math.min(limit, RING_MAX)); } catch { return []; }
}

// Force flush (admin/test) for external sink
export async function flushLogsExternal(env:any){ await flushExternal(env); }

// Expose sink stats for diagnostics
export function logSinkStats(){ return { ...sinkStats, pending: pendingExternal.length, memory_flushes: memoryFlushes.length }; }
export function _testMemoryFlushes(){ return memoryFlushes; }

