// Idempotency key helper (simple D1 table). Stores hash of request body for conflict detection.
// Table: idempotency_keys (key TEXT PRIMARY KEY, route TEXT, body_hash TEXT, status INTEGER, response TEXT, created_at TEXT)

import type { Env } from './types';
import { sha256Hex } from './crypto';

export interface IdempotencyRecord { key: string; route: string; status: number; response: string; body_hash: string; created_at: string; }

async function ensureTable(env: Env) {
  try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, route TEXT, body_hash TEXT, status INTEGER, response TEXT, created_at TEXT);`).run(); } catch {/* ignore */}
}

export async function beginIdempotent(env: Env, route: string, key: string, body: string): Promise<{ replay?: IdempotencyRecord; conflict?: boolean; proceed?: boolean; }> {
  if (!key) return { proceed: true }; // no idempotency
  await ensureTable(env);
  const bodyHash = await sha256Hex(body || '');
  const rs = await env.DB.prepare(`SELECT key, route, body_hash, status, response, created_at FROM idempotency_keys WHERE key=?`).bind(key).all();
  const row:any = rs.results?.[0];
  if (!row) {
    // Reserve slot (optimistic; conflict if racing)
    try {
      await env.DB.prepare(`INSERT INTO idempotency_keys (key, route, body_hash, status, response, created_at) VALUES (?,?,?,?,?,datetime('now'))`).bind(key, route, bodyHash, -1, '',).run();
    } catch {/* possible race */}
    return { proceed: true };
  }
  if (row.body_hash !== bodyHash) {
    return { conflict: true };
  }
  if (row.status >= 0 && row.response) {
    return { replay: row as IdempotencyRecord };
  }
  return { proceed: true };
}

export async function finalizeIdempotent(env: Env, key: string, status: number, response: string) {
  if (!key) return; try { await env.DB.prepare(`UPDATE idempotency_keys SET status=?, response=? WHERE key=?`).bind(status, response, key).run(); } catch {/* ignore */}
}
