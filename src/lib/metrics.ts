import { Env } from './types';
import { log } from './log';

export async function incMetric(env: Env, metric: string) {
	try {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
		const today = new Date().toISOString().slice(0,10);
		await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,1) ON CONFLICT(d,metric) DO UPDATE SET count = count + 1`).bind(today, metric).run();
	} catch (e) { log('metric_error', { metric, error: String(e) }); }
}

export async function incMetricBy(env: Env, metric: string, delta: number) {
	try {
		const d = (!Number.isFinite(delta) || delta <= 0) ? 1 : Math.floor(delta);
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
		const today = new Date().toISOString().slice(0,10);
		await env.DB.prepare(`INSERT INTO metrics_daily (d, metric, count) VALUES (?,?,?) ON CONFLICT(d,metric) DO UPDATE SET count = count + ${d}`).bind(today, metric, d).run();
	} catch (e) { log('metric_error', { metric, error: String(e) }); }
}

export async function recordLatency(env: Env, tag: string, ms: number) {
	try {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
		const today = new Date().toISOString().slice(0,10);
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
	} catch (e) { log('metric_latency_error', { tag, error: String(e) }); }
}

