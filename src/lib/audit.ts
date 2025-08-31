import type { Env } from './types';
import { log } from './log';

export interface AuditFields { actor_type: string; actor_id?: string|null; action: string; resource: string; resource_id?: string|null; details?: any }

function redactDetails(obj: any): any {
	if (obj == null) return obj;
	if (Array.isArray(obj)) return obj.slice(0,50).map(redactDetails);
	if (typeof obj === 'object') {
		const out: Record<string, unknown> = {};
		const REDACT = new Set(['secret','manage_token','token','email']);
		for (const [k,v] of Object.entries(obj)) {
			if (REDACT.has(k.toLowerCase())) { out[k] = '[REDACTED]'; continue; }
			out[k] = redactDetails(v);
		}
		return out;
	}
	if (typeof obj === 'string') return obj.length>256? obj.slice(0,256)+'…': obj;
	return obj;
}

export async function audit(env: Env, f: AuditFields) {
	try {
		const id = crypto.randomUUID();
		const ts = new Date().toISOString();
		let detailsObj = f.details;
		try { detailsObj = redactDetails(detailsObj); } catch {/* ignore */}
		const details = detailsObj === undefined ? null : JSON.stringify(detailsObj).slice(0,2000);
		await env.DB.prepare(`INSERT INTO mutation_audit (id, ts, actor_type, actor_id, action, resource, resource_id, details) VALUES (?,?,?,?,?,?,?,?)`)
			.bind(id, ts, f.actor_type, f.actor_id||null, f.action, f.resource, f.resource_id||null, details).run();
	} catch (e) { log('audit_insert_error', { error: String(e) }); }
}

