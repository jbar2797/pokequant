import { log } from './log';
import type { Env } from './types';

// Lightweight retention purge logic extracted from index.ts
export async function purgeOldData(env: Env, overrides?: Record<string, number>) {
  try {
    // Preflight: ensure tables we may touch exist (avoid uncaught 'no such table' causing runtime disconnect)
    try {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS data_completeness (dataset TEXT NOT NULL, as_of DATE NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY(dataset, as_of));`),
      ]);
    } catch {/* ignore */}
    const windows: Record<string, number> = {
      backtests: 30,
      mutation_audit: 30,
      anomalies: 30,
      metrics_daily: 14,
      data_completeness: 30
    };
    // Load dynamic overrides from retention_config table if present
    try {
      const exists = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='retention_config'`).all();
      if ((exists.results||[]).length) {
        const rs = await env.DB.prepare(`SELECT table_name, days FROM retention_config`).all();
        for (const r of (rs.results||[]) as any[]) {
          const tn = r.table_name; const d = Number(r.days);
          if (windows[tn] !== undefined && Number.isFinite(d) && d>=0 && d<=365) windows[tn] = d;
        }
      }
    } catch { /* ignore */ }
    for (const k of Object.keys(windows)) {
      const envKey = `RETENTION_${k.toUpperCase()}_DAYS` as keyof Env;
      const raw = (env as any)[envKey];
      if (raw !== undefined) {
        const v = parseInt(String(raw),10);
        if (Number.isFinite(v) && v>=0 && v<=365) windows[k] = v;
      }
    }
    if (overrides) {
      for (const [k,v] of Object.entries(overrides)) {
        if (windows[k] !== undefined) windows[k] = v;
      }
    }
    const out: Record<string, number> = {};
    for (const [table, days] of Object.entries(windows)) {
      try {
        const exists = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(table).all();
        if (!(exists.results||[]).length) continue;
        if (table === 'metrics_daily') {
          const del = await env.DB.prepare(`DELETE FROM metrics_daily WHERE d < date('now','-${days} day')`).run();
          out[table] = (del as any).meta?.changes || 0; continue;
        }
        if (table === 'data_completeness') {
          const del = await env.DB.prepare(`DELETE FROM data_completeness WHERE as_of < date('now','-${days} day')`).run();
          out[table] = (del as any).meta?.changes || 0; continue;
        }
        let cond = '';
        if (table === 'backtests') cond = `created_at < datetime('now','-${days} day')`;
        else if (table === 'mutation_audit') cond = `ts < datetime('now','-${days} day')`;
        else if (table === 'anomalies') cond = `created_at < datetime('now','-${days} day')`;
        if (!cond) continue;
        const del = await env.DB.prepare(`DELETE FROM ${table} WHERE ${cond}`).run();
        out[table] = (del as any).meta?.changes || 0;
      } catch (e) { log('retention_table_error', { table, error: String(e) }); }
    }
    return out;
  } catch (e) {
    log('retention_error', { error: String(e) });
    return {};
  }
}
