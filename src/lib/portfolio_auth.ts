import { Env } from './types';
import { sha256Hex } from './crypto';
import { incMetric } from './metrics';

export async function portfolioAuth(env: Env, id: string, secret: string): Promise<{ ok: boolean; legacy: boolean; }> {
	if (!id || !secret) return { ok:false, legacy:false };
	try {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
		try { await env.DB.prepare(`ALTER TABLE portfolios ADD COLUMN secret_hash TEXT`).run(); } catch {/* ignore */}
		const rowRes = await env.DB.prepare(`SELECT secret, secret_hash FROM portfolios WHERE id=?`).bind(id).all();
		const row: any = rowRes.results?.[0];
		if (!row) return { ok:false, legacy:false };
		const providedHash = await sha256Hex(secret);
		const legacyOk = row.secret === secret;
		const hashOk = !!row.secret_hash && row.secret_hash === providedHash;
		if (hashOk || legacyOk) {
			if (!row.secret_hash && legacyOk) {
				try { await env.DB.prepare(`UPDATE portfolios SET secret_hash=? WHERE id=?`).bind(providedHash, id).run(); } catch {/* ignore */}
			}
			if (legacyOk && !hashOk) {
				await incMetric(env, 'portfolio.auth_legacy');
			}
			return { ok:true, legacy: legacyOk && !hashOk };
		}
		return { ok:false, legacy:false };
	} catch { return { ok:false, legacy:false }; }
}

