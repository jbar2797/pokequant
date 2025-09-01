import type { Env } from './types';
import { log } from './log';

// Robust schema ensure with verification + singleflight. D1 test harness can reuse the
// same DB object while rotating underlying storage between test files, so a WeakSet
// alone causes stale "ensured" state and subsequent "no such table" errors.
// We instead keep a per-DB state with an in-flight promise and always run cheap
// idempotent CREATE TABLE / VIEW statements (fast in SQLite) after a rotation is
// detected (missing table) or after a previous missing-table failure.
interface EnsureState { promise: Promise<void>|null; lastOk: number; hadError: boolean }
const ensureStates = new WeakMap<any, EnsureState>();

async function ensureMetricsTable(env: Env) {
	const dbObj: any = env.DB as any;
	let st = ensureStates.get(dbObj);
	if (!st) { st = { promise: null, lastOk: 0, hadError: false }; ensureStates.set(dbObj, st); }
	// Fast path: recently ensured (<5s) and no prior error.
	if (!st.hadError && st.lastOk && Date.now() - st.lastOk < 5000) return;
	if (!st.promise) {
		st.promise = (async () => {
			try {
				// Create table & latency view (view depends on table existing). Both idempotent.
				await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
				await env.DB.prepare(`CREATE VIEW IF NOT EXISTS metrics_latency AS SELECT d, REPLACE(REPLACE(metric,'.p50',''),'.p95','') AS base_metric, MAX(CASE WHEN metric LIKE '%.p50' THEN count/1000.0 END) AS p50_ms, MAX(CASE WHEN metric LIKE '%.p95' THEN count/1000.0 END) AS p95_ms FROM metrics_daily WHERE metric LIKE 'lat.%' GROUP BY d, base_metric;`).run();
				st.lastOk = Date.now();
				st.hadError = false;
			} catch (e) {
				st.hadError = true; // force re-attempt next call
				log('metric_ensure_error', { error: String(e) });
			} finally {
				st.promise = null;
			}
		})();
	}
	return st.promise;
}

// Public schema ensure helper (idempotent) for early initialization paths.
export async function ensureMetricsSchema(env: Env) { await ensureMetricsTable(env); }

function todayKey() { return new Date().toISOString().slice(0,10); }

export async function incMetric(env: Env, metric: string) {
	try {
		await ensureMetricsTable(env);
		const today = todayKey();
		try {
			await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,1) ON CONFLICT(d,metric) DO UPDATE SET count = count + 1`).bind(today, metric).run();
		} catch (e:any) {
			// Retry once if table missing due to rare creation race
			if (/no such table/i.test(String(e))) {
          // Invalidate ensure state so next ensure re-verifies immediately
          const st = ensureStates.get(env.DB as any); if (st) { st.lastOk = 0; st.hadError = true; }
				try { await ensureMetricsTable(env); await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,1) ON CONFLICT(d,metric) DO UPDATE SET count = count + 1`).bind(today, metric).run(); return; } catch {/* fallthrough */}
			}
			throw e;
		}
	} catch (e) { log('metric_error', { metric, error: String(e) }); }
}

export async function incMetricBy(env: Env, metric: string, delta: number) {
	try {
		await ensureMetricsTable(env);
		const d = (!Number.isFinite(delta) || delta <= 0) ? 1 : Math.floor(delta);
		const today = todayKey();
		try {
			await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count = count + ${d}`).bind(today, metric, d).run();
		} catch (e:any) {
			if (/no such table/i.test(String(e))) {
          const st = ensureStates.get(env.DB as any); if (st) { st.lastOk = 0; st.hadError = true; }
				try { await ensureMetricsTable(env); await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count = count + ${d}`).bind(today, metric, d).run(); return; } catch {/* ignore */}
			}
			throw e;
		}
	} catch (e) { log('metric_error', { metric, error: String(e) }); }
}

// Batch increment helper to reduce round trips when many metrics emitted together.
export async function incMetricsBatch(env: Env, metrics: Record<string, number|undefined>) {
	try {
		await ensureMetricsTable(env);
		const today = todayKey();
		for (const [metric, deltaRaw] of Object.entries(metrics)) {
			const d = (!Number.isFinite(deltaRaw as number) || (deltaRaw||0) <= 0) ? 1 : Math.floor(deltaRaw as number);
			await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count = count + ${d}`).bind(today, metric, d).run();
		}
	} catch (e) { log('metric_batch_error', { error: String(e) }); }
}

export async function recordLatency(env: Env, tag: string, ms: number) {
	// We want to avoid noisy logs on first access after a DB rotation. Retry once if table missing at any stage.
	for (let attempt=0; attempt<2; attempt++) {
		try {
			await ensureMetricsTable(env);
			const today = todayKey();
			const p50Key = `${tag}.p50`;
			const p95Key = `${tag}.p95`;
			const alpha50 = 0.2, alpha95 = 0.1;
			const fetchVal = async (k:string) => {
				const r = await env.DB.prepare(`SELECT count FROM metrics_daily WHERE d=? AND metric=?`).bind(today, k).all();
				return Number(r.results?.[0]?.count) || 0;
			};
			const cur50 = await fetchVal(p50Key);
			const cur95 = await fetchVal(p95Key);
			const new50 = cur50 === 0 ? ms*1000 : Math.round((1-alpha50)*cur50 + alpha50*ms*1000);
			const estP95 = Math.max(ms*1000, cur95 === 0 ? ms*1000 : Math.round((1-alpha95)*cur95 + alpha95*ms*1000* (ms*1000>cur95?1:0.5)));
			const upsert = async (k:string, v:number) => {
				await env.DB.prepare(`INSERT INTO metrics_daily (d,metric,count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count=?`).bind(today,k,v,v).run();
			};
			await upsert(p50Key, new50);
			await upsert(p95Key, estP95);
			return; // success
		} catch (e:any) {
			if (/no such table/i.test(String(e)) && attempt === 0) {
				const st = ensureStates.get(env.DB as any); if (st) { st.lastOk = 0; st.hadError = true; }
				continue; // retry once after invalidating ensure state
			}
			log('metric_latency_error', { tag, error: String(e) });
			return;
		}
	}
}

// Gauge-like setter: store an absolute value for a metric (overwrites prior for the day).
export async function setMetric(env: Env, metric: string, value: number) {
	try {
		await ensureMetricsTable(env);
		const today = todayKey();
		const v = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
		const upsert = async () => {
			await env.DB.prepare(`INSERT INTO metrics_daily (d,metric,count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count=?`).bind(today, metric, v, v).run();
		};
		try { await upsert(); }
		catch (e:any) {
			if (/no such table/i.test(String(e))) { const st = ensureStates.get(env.DB as any); if (st) { st.lastOk = 0; st.hadError = true; } try { await ensureMetricsTable(env); await upsert(); return; } catch {/* ignore */} }
			throw e;
		}
	} catch (e) { log('metric_set_error', { metric, error: String(e) }); }
}

// Lightweight timing instrumentation (opt-in via env flag) to debug CI hotspots.
export async function timeSection<T>(env: Env, label: string, fn: ()=>Promise<T>): Promise<T> {
	const start = Date.now();
	try { return await fn(); }
	finally {
		if ((env as any).DEBUG_TIMINGS) {
			log('timing', { label, ms: Date.now() - start });
		}
	}
}

