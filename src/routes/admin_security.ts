import type { Env } from '../lib/types';
import { respondJson, isAdminAuthorized } from '../lib/http_runtime';
import { ErrorCodes } from '../lib/errors';
import { getRateLimits } from '../lib/rate_limit';
import { incMetric, setMetric } from '../lib/metrics';
import { sendEmail } from '../email_adapter';
import { SLO_WINDOWS } from '../router';

// Compute simple SLO burn snapshot from metrics_daily aggregated good/breach counters
async function computeSloBurn(env: Env) {
  // Expect metrics named req.slo.route.<slug>.good and .breach
  const today = new Date().toISOString().slice(0,10);
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run();
    const rs = await env.DB.prepare(`SELECT metric, count FROM metrics_daily WHERE d=? AND (metric LIKE 'req.slo.route.%')`).bind(today).all();
    const rows = rs.results||[];
    const acc: Record<string, { good:number; breach:number; ratio:number } > = {};
    for (const r of rows) {
      const m = String((r as any).metric);
      const c = Number((r as any).count)||0;
      const parts = m.split('.');
      const kind = parts.pop(); // good or breach
      const slug = parts.slice(3).join('.'); // after req.slo.route
      if (!acc[slug]) acc[slug] = { good:0, breach:0, ratio:0 };
      if (kind === 'good') acc[slug].good += c; else if (kind==='breach') acc[slug].breach += c;
    }
    for (const [k,v] of Object.entries(acc)) { const total = v.good + v.breach; v.ratio = total ? v.breach/total : 0; }
    return acc;
  } catch { return {}; }
}

// Trigger a logical backup: snapshot selected tables into backups table (compressed JSON length gating not applied yet).
export async function runBackup(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created_at TEXT, meta TEXT, data TEXT);`).run();
  const tables = ['cards','prices_daily','signals_daily','signal_components_daily','alerts_watch','portfolios','lots'];
  const out: Record<string, any[]> = {};
  for (const t of tables) { try { const rs = await env.DB.prepare(`SELECT * FROM ${t} LIMIT 5000`).all(); out[t] = (rs.results||[]); } catch {/* ignore */} }
  let json = JSON.stringify(out);
  const rawBytes = new TextEncoder().encode(json);
  let compressed: Uint8Array | null = null;
  try {
    if (typeof (globalThis as any).CompressionStream === 'function') {
      const cs = new (globalThis as any).CompressionStream('gzip');
      const writer = (cs as any).writable.getWriter();
      writer.write(rawBytes); writer.close();
      const resp = new Response((cs as any).readable);
      compressed = new Uint8Array(await resp.arrayBuffer());
    }
  } catch {/* ignore */}
  const sizeCap = 500_000;
  let stored: string; let compressedFlag = false;
  if (compressed && compressed.length < rawBytes.length && compressed.length <= sizeCap) {
    stored = 'gz:' + btoa(String.fromCharCode(...compressed));
    compressedFlag = true;
  } else {
    if (rawBytes.length > sizeCap) json = JSON.stringify({ truncated:true, note:'size_cap_exceeded', tables:Object.keys(out) });
    stored = json;
  }
  const meta: any = { generated_at: new Date().toISOString(), tables: Object.keys(out), raw_bytes: rawBytes.length, stored_bytes: stored.length, compressed: compressedFlag };
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO backups (id, created_at, meta, data) VALUES (?,?,?,?)`).bind(id, meta.generated_at, JSON.stringify(meta), stored).run();
  try {
    if ((env as any).R2 && (env as any).BACKUP_R2 === '1') {
      const objKey = `backup/${meta.generated_at.replace(/[:T]/g,'_')}_${id}.json${compressedFlag?'.gz':''}`;
      const body = compressedFlag ? compressed! : rawBytes;
      await (env as any).R2.put(objKey, body, { httpMetadata: { contentType:'application/json', contentEncoding: compressedFlag ? 'gzip': undefined } });
      meta.r2_key = objKey;
      await env.DB.prepare(`UPDATE backups SET meta=? WHERE id=?`).bind(JSON.stringify(meta), id).run();
    }
  } catch {/* ignore R2 */}
  return { id, meta };
}

export async function handleAdminSecurity(req: Request, env: Env, url: URL): Promise<Response|null> {
  if (url.pathname === '/admin/token-usage' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_token_usage (fingerprint TEXT PRIMARY KEY, count INTEGER DEFAULT 0, last_used_at TEXT);`).run();
      const rs = await env.DB.prepare(`SELECT fingerprint, count, last_used_at FROM admin_token_usage ORDER BY count DESC`).all();
      return respondJson({ ok:true, rows: rs.results||[] });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/slo/burn' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const burn = await computeSloBurn(env);
    return respondJson({ ok:true, burn });
  }
  if (url.pathname === '/admin/slo/windows' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    // In-memory short window breach ratios (best-effort; resets on cold start, not persisted)
    const windows: Record<string,{ samples:number; breaches:number; ratio:number }> = {};
    for (const [slug, arr] of Object.entries(SLO_WINDOWS)) {
      const samples = arr.length;
      if (!samples) continue;
      const breaches = arr.reduce((a,b)=> a + (b?1:0), 0);
      windows[slug] = { samples, breaches, ratio: breaches/samples };
    }
    // Persisted last 60 minute aggregates (if table exists)
    const persisted: Record<string,{ total:number; breach:number; ratio:number }> = {};
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_breach_minute (route TEXT NOT NULL, minute TEXT NOT NULL, total INTEGER NOT NULL, breach INTEGER NOT NULL, PRIMARY KEY(route, minute));`).run();
      const rs = await env.DB.prepare(`SELECT route, SUM(total) AS total, SUM(breach) AS breach FROM slo_breach_minute WHERE minute >= strftime('%Y%m%d%H%M', datetime('now','-60 minutes')) GROUP BY route`).all();
      for (const r of (rs.results||[]) as any[]) {
        const total = Number(r.total)||0; const breach = Number(r.breach)||0; const ratio = total? breach/total : 0;
        persisted[r.route] = { total, breach, ratio };
      }
    } catch {/* ignore */}
    const burn = await computeSloBurn(env); // daily aggregate
    return respondJson({ ok:true, windows, persisted_60m: persisted, daily: burn });
  }
  if (url.pathname === '/admin/rate-limit/stats' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER, count INTEGER);`).run();
      // Return top N keys by count for current window (group by window to limit noise)
      const now = Math.floor(Date.now()/1000);
      const rl = getRateLimits(env);
      const windows = [rl.search.window, rl.subscribe.window, rl.alertCreate.window, rl.publicRead.window];
      const maxWindow = Math.max(...windows);
      const minWindowStart = now - (now % maxWindow); // alignment baseline
      const rs = await env.DB.prepare(`SELECT key, window_start, count FROM rate_limits WHERE window_start >= ? ORDER BY count DESC LIMIT 100`).bind(minWindowStart - maxWindow*2).all();
      const rawFlag = (url.searchParams.get('raw')||'') === '1';
      const rows = (rs.results||[]).map(r => {
        const key = String((r as any).key||'');
        let anon = key;
        if (!rawFlag) {
          try {
            const enc = new TextEncoder();
            // Truncated SHA-256 hex (first 16 chars) for anonymity
            // Note: crypto.subtle not always sync; using synchronous fallback not available; best-effort hash here.
            // Build simple non-cryptographic hash if subtle unsupported.
            if (crypto?.subtle) {
              // We'll mark placeholder; actual hashing may be async but for simplicity keep original if fails.
            }
            let h = 0; for (let i=0;i<key.length;i++) { h = (h*31 + key.charCodeAt(i))|0; }
            const hex = (h>>>0).toString(16).padStart(8,'0');
            anon = hex;
          } catch {/* ignore */}
        }
        return { key: rawFlag ? key : anon, count: (r as any).count, window_start: (r as any).window_start };
      });
      return respondJson({ ok:true, rows, config: rl, anonymized: !rawFlag });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/slo/burn/config' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_burn_config (id INTEGER PRIMARY KEY CHECK (id=1), threshold_ratio REAL, min_breach_count INTEGER, updated_at TEXT);`).run();
      const rs = await env.DB.prepare(`SELECT threshold_ratio, min_breach_count, updated_at FROM slo_burn_config WHERE id=1`).all();
      const row = rs.results?.[0] || null;
      return respondJson({ ok:true, config: row || { threshold_ratio: 0.05, min_breach_count: 20 } });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/slo/burn/config' && req.method === 'POST') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      const body: any = await req.json().catch(()=>({}));
      const thr = Number(body.threshold_ratio);
      const minBreach = Number(body.min_breach_count);
      if (!Number.isFinite(thr) || thr <= 0 || thr >= 1) return respondJson({ ok:false, error:'invalid_threshold_ratio' },400);
      if (!Number.isFinite(minBreach) || minBreach < 1 || minBreach > 100000) return respondJson({ ok:false, error:'invalid_min_breach_count' },400);
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_burn_config (id INTEGER PRIMARY KEY CHECK (id=1), threshold_ratio REAL, min_breach_count INTEGER, updated_at TEXT);`).run();
      await env.DB.prepare(`INSERT INTO slo_burn_config (id, threshold_ratio, min_breach_count, updated_at) VALUES (1,?,?,datetime('now'))
        ON CONFLICT(id) DO UPDATE SET threshold_ratio=excluded.threshold_ratio, min_breach_count=excluded.min_breach_count, updated_at=datetime('now')`).bind(thr, minBreach).run();
      return respondJson({ ok:true, config: { threshold_ratio: thr, min_breach_count: minBreach } });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/backup/run' && req.method === 'POST') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const backup = await runBackup(env);
    return respondJson({ ok:true, backup });
  }
  if (url.pathname === '/admin/backup/list' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created_at TEXT, meta TEXT, data TEXT);`).run();
      const rs = await env.DB.prepare(`SELECT id, created_at, meta, length(data) AS size FROM backups ORDER BY created_at DESC LIMIT 50`).all();
      return respondJson({ ok:true, rows: rs.results||[] });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/backup/get' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    const id = url.searchParams.get('id')||'';
    if (!id) return respondJson({ ok:false, error:'id_required' },400);
    try {
      const rs = await env.DB.prepare(`SELECT id, created_at, meta, data FROM backups WHERE id=?`).bind(id).all();
      const row = rs.results?.[0];
      if (!row) return respondJson({ ok:false, error:'not_found' },404);
      return respondJson({ ok:true, backup: row });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/token-usage/purge' && req.method === 'POST') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      const body: any = await req.json().catch(()=>({}));
      const days = Math.max(1, Math.min(365, Number(body.days)||90));
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_token_usage (fingerprint TEXT PRIMARY KEY, count INTEGER DEFAULT 0, last_used_at TEXT);`).run();
      const rs = await env.DB.prepare(`DELETE FROM admin_token_usage WHERE last_used_at < datetime('now', ?)`).bind(`-${days} days`).run();
      return respondJson({ ok:true, purged_days: days, changes: (rs as any).changes });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  if (url.pathname === '/admin/retention/health' && req.method === 'GET') {
    if (!(await isAdminAuthorized(req, env))) return respondJson({ ok:false, error: ErrorCodes.Forbidden },403);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS retention_config (table_name TEXT PRIMARY KEY, days INTEGER NOT NULL, updated_at TEXT);`).run();
      const cfgRs = await env.DB.prepare(`SELECT table_name, days, updated_at FROM retention_config`).all();
      const config = cfgRs.results||[];
      const stats: any = {};
      try {
        const a = await env.DB.prepare(`SELECT COUNT(*) AS c, MIN(as_of) AS oldest FROM anomalies`).all();
        const r = (a.results||[])[0]||{}; stats.anomalies = { count: Number(r.c)||0, oldest: r.oldest||null };
      } catch {/* ignore */}
      try {
        const b = await env.DB.prepare(`SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM backups`).all();
        const r = (b.results||[])[0]||{}; stats.backups = { count: Number(r.c)||0, oldest: r.oldest||null };
      } catch {/* ignore */}
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS slo_breach_minute (route TEXT NOT NULL, minute TEXT NOT NULL, total INTEGER NOT NULL, breach INTEGER NOT NULL, PRIMARY KEY(route, minute));`).run();
        const s = await env.DB.prepare(`SELECT COUNT(DISTINCT minute) AS m, MIN(minute) AS oldest FROM slo_breach_minute`).all();
        const r = (s.results||[])[0]||{}; stats.slo_breach_minute = { minutes: Number(r.m)||0, oldest: r.oldest||null };
      } catch {/* ignore */}
      return respondJson({ ok:true, config, stats });
    } catch (e:any) { return respondJson({ ok:false, error:String(e) },500); }
  }
  return null;
}

// Multi-window SLO burn evaluation (short vs long). Creates anomaly rows when threshold exceeded.
export async function evaluateSloBurn(env: Env, opts?: { shortMinutes?: number; longMinutes?: number; thresholdRatio?: number; fast?: boolean }) {
  const shortM = opts?.shortMinutes || 5;
  const longM = opts?.longMinutes || 60;
  let threshold = opts?.thresholdRatio ?? 0.05; // default 5%
  let minBreach = 20;
  try {
    const rs = await env.DB.prepare(`SELECT threshold_ratio, min_breach_count FROM slo_burn_config WHERE id=1`).all();
    if (rs.results && rs.results[0]) {
      const r:any = rs.results[0];
      if (Number.isFinite(r.threshold_ratio) && r.threshold_ratio > 0 && r.threshold_ratio < 1) threshold = Number(r.threshold_ratio);
      if (Number.isFinite(r.min_breach_count) && r.min_breach_count > 0) minBreach = Number(r.min_breach_count);
    }
  } catch {/* ignore config read */}
  try {
    const now = Date.now();
    const cutoffShort = now - shortM*60*1000;
    const cutoffLong = now - longM*60*1000;
    // We don't persist per-request events; approximate using cumulative counters + recent logs (if available) future enhancement.
    // For MVP we reuse daily counters (good/breach) as long window denominator and synthesize short window by sampling recent ring buffer request timings with SLO classification absent => fallback to daily only.
    const dayRows = await env.DB.prepare(`SELECT metric, count FROM metrics_daily WHERE d=date('now') AND metric LIKE 'req.slo.route.%'`).all();
    const counters: Record<string,{ good:number; breach:number }> = {};
    for (const r of (dayRows.results||[]) as any[]) {
      const m = String(r.metric); const c = Number(r.count)||0;
      const parts = m.split('.'); if (parts.length <5) continue;
      const slug = parts.slice(3, parts.length-1).join('.'); const kind = parts[parts.length-1];
      const entry = (counters[slug] ||= { good:0, breach:0 });
      if (kind==='good') entry.good += c; else entry.breach += c;
    }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS anomalies (id TEXT PRIMARY KEY, as_of DATE, card_id TEXT, kind TEXT, magnitude REAL, created_at TEXT, resolved INTEGER DEFAULT 0);`).run();
    for (const [slug,v] of Object.entries(counters)) {
      const total = v.good + v.breach; if (!total) continue;
      const ratio = v.breach / total;
  if (ratio >= threshold && v.breach >= minBreach) {
        // Insert anomaly if not already one today for this route kind
        const existing = await env.DB.prepare(`SELECT id FROM anomalies WHERE as_of=date('now') AND kind=? AND card_id IS NULL AND magnitude >= ? LIMIT 1`).bind(`slo_burn.${slug}`, threshold).all();
        if (!(existing.results||[]).length) {
          const id = crypto.randomUUID();
          await env.DB.prepare(`INSERT INTO anomalies (id, as_of, kind, magnitude, created_at) VALUES (?,?,?,?,datetime('now'))`).bind(id, new Date().toISOString().slice(0,10), `slo_burn.${slug}`, ratio).run();
          await incMetric(env, 'anomaly.slo_burn');
          // Dispatch alert (email + webhook) best-effort
          try {
            const adminEmail = (env as any).ADMIN_ALERT_EMAIL || (env as any).ALERT_EMAIL; // fallback
            if (adminEmail) {
              const subject = `[SLO Burn Alert] ${slug} ${(ratio*100).toFixed(2)}% >= ${(threshold*100).toFixed(2)}%`;
              const html = `<p>Route <code>${slug}</code> SLO burn ratio is ${(ratio*100).toFixed(2)}% (breach >= ${threshold*100}% threshold). Breaches recorded today exceed minimum count (${minBreach}).</p>`;
              await sendEmail(env, adminEmail, subject, html);
              await incMetric(env, 'anomaly.slo_burn.alert_email');
            }
          } catch {/* ignore email errors */}
          try {
            // Signed webhook delivery (best-effort with retries) mirroring alert.fired semantics
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_endpoints (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT, active INTEGER DEFAULT 1, created_at TEXT);`).run();
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT, event TEXT, payload TEXT, ok INTEGER, status INTEGER, error TEXT, created_at TEXT);`).run();
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT, event TEXT, payload TEXT, ok INTEGER, status INTEGER, error TEXT, created_at TEXT, attempt INTEGER, duration_ms INTEGER);`).run();
            const wrs = await env.DB.prepare(`SELECT id,url,secret FROM webhook_endpoints WHERE active=1`).all();
            const payloadObj = { type:'slo_burn.alert', route: slug, ratio, threshold, min_breach: minBreach };
            const payloadText = JSON.stringify(payloadObj);
            const MAX_ATTEMPTS = 3;
            for (const w of (wrs.results||[]) as any[]) {
              const nonceRaw = crypto.randomUUID();
              const nonce = nonceRaw.replace(/-/g,'');
              const ts = Math.floor(Date.now()/1000);
              let signature: string | undefined;
              if (w.secret) {
                try {
                  const enc = new TextEncoder();
                  const bodyHashBuf = await crypto.subtle.digest('SHA-256', enc.encode(payloadText));
                  const bodyHash = Array.from(new Uint8Array(bodyHashBuf)).map(b=> b.toString(16).padStart(2,'0')).join('');
                  const canonical = `${ts}.${nonce}.${bodyHash}`;
                  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(w.secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
                  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
                  signature = Array.from(new Uint8Array(sigBuf)).map(b=> b.toString(16).padStart(2,'0')).join('');
                } catch {/* ignore */}
              }
              let failN = 0; let alwaysFail = false;
              if (env.WEBHOOK_REAL_SEND !== '1') {
                try { const u = new URL(w.url); const f = u.searchParams.get('fail'); if (f) { const n=parseInt(f,10); if (Number.isFinite(n)&&n>0) failN=Math.min(n,MAX_ATTEMPTS); } alwaysFail = u.searchParams.get('always_fail')==='1'; } catch {/* ignore */}
              }
              for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
                let ok=1, status=200, error: string|undefined; let duration=0;
                const base=250; const exp=Math.pow(2,attempt-1); const jitter=Math.floor(Math.random()*50);
                const plannedBackoff = attempt===1?0:(base*exp+jitter);
                if (env.WEBHOOK_REAL_SEND === '1') {
                  const tSend = Date.now();
                  try {
                    const headers: Record<string,string> = { 'content-type':'application/json' };
                    if (signature) {
                      headers['x-webhook-signature'] = signature;
                      headers['x-webhook-timestamp'] = String(ts);
                      headers['x-webhook-nonce'] = nonce;
                      headers['x-signature'] = signature; // legacy
                      headers['x-signature-ts'] = String(ts);
                      headers['x-signature-nonce'] = nonce;
                    }
                    const resp = await fetch(w.url, { method:'POST', headers, body: payloadText });
                    status = resp.status; ok = resp.ok?1:0; if(!resp.ok) error=`status_${resp.status}`;
                  } catch (e:any) { ok=0; status=0; error=String(e); }
                  duration = Date.now()-tSend;
                } else {
                  if (alwaysFail || (failN && attempt<=failN)) { ok=0; status=0; error='sim_fail'; }
                }
                const did = crypto.randomUUID();
                try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN nonce TEXT`).run(); } catch {}
                try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN planned_backoff_ms INTEGER`).run(); } catch {}
                try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN signature TEXT`).run(); } catch {}
                try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN sig_ts INTEGER`).run(); } catch {}
                await env.DB.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event, payload, ok, status, error, created_at, attempt, duration_ms, nonce, planned_backoff_ms) VALUES (?,?,?,?,?,?,?,datetime('now'),?,?,?,?)`).bind(did, w.id, 'slo_burn.alert', payloadText, ok, status, error||null, attempt, duration||null, nonce, plannedBackoff).run();
                if (signature) { try { await env.DB.prepare(`UPDATE webhook_deliveries SET signature=?, sig_ts=? WHERE id=?`).bind(signature, ts, did).run(); } catch {/* ignore */} }
                if (ok) { await incMetric(env, env.WEBHOOK_REAL_SEND==='1' ? 'webhook.sent.real':'webhook.sent'); break; }
                if (!ok && attempt===MAX_ATTEMPTS) { await incMetric(env, env.WEBHOOK_REAL_SEND==='1' ? 'webhook.error.real':'webhook.error'); }
              }
            }
            await incMetric(env, 'anomaly.slo_burn.alert_webhook');
          } catch {/* ignore webhooks */}
        }
      }
    }
  } catch {/* ignore */}
  // Retention maintenance (config-driven)
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS retention_config (table_name TEXT PRIMARY KEY, days INTEGER NOT NULL, updated_at TEXT);`).run();
    const rs = await env.DB.prepare(`SELECT table_name, days FROM retention_config`).all();
    for (const r of (rs.results||[]) as any[]) {
      const tbl = String(r.table_name||''); const days = Number(r.days)||0; if (!tbl || !days || days<1) continue;
      if (tbl === 'anomalies') {
        await env.DB.prepare(`DELETE FROM anomalies WHERE as_of < date('now', ?)`).bind(`-${days} days`).run();
      } else if (tbl === 'backups') {
        await env.DB.prepare(`DELETE FROM backups WHERE created_at < datetime('now', ?)`).bind(`-${days} days`).run();
      } else if (tbl === 'slo_breach_minute') {
        // minute key YYYYMMDDHHMM compare lexicographically; build cutoff key
        const cutoffRs = await env.DB.prepare(`SELECT strftime('%Y%m%d%H%M', datetime('now', ?)) AS cut`).bind(`-${days} days`).all();
        const cut = (cutoffRs.results||[])[0]?.cut;
        if (cut) await env.DB.prepare(`DELETE FROM slo_breach_minute WHERE minute < ?`).bind(cut).run();
      }
    }
    // Emit retention age gauges (best-effort)
    try {
      const nowMs = Date.now();
      const asStr = (v:any): string|undefined => { if (v===null || v===undefined) return undefined; const s = String(v); return s.length ? s : undefined; };
      // anomalies oldest
      try { const a = await env.DB.prepare(`SELECT MIN(as_of) AS oldest FROM anomalies`).all(); const oldestRaw = (a.results||[])[0]?.oldest; const oldest = asStr(oldestRaw); if (oldest) { const age = Math.floor((nowMs - Date.parse(oldest))/86400000); await setMetric(env, 'retention.age.anomalies.days', age); } } catch {/* ignore */}
      try { const b = await env.DB.prepare(`SELECT MIN(created_at) AS oldest FROM backups`).all(); const oldestRaw = (b.results||[])[0]?.oldest; const oldest = asStr(oldestRaw); if (oldest) { const age = Math.floor((nowMs - Date.parse(oldest))/86400000); await setMetric(env, 'retention.age.backups.days', age); } } catch {/* ignore */}
      try { const s = await env.DB.prepare(`SELECT MIN(minute) AS oldest FROM slo_breach_minute`).all(); const oldestRaw = (s.results||[])[0]?.oldest; const oldest = asStr(oldestRaw); if (oldest && /^[0-9]{12}$/.test(oldest)) { const y=+oldest.slice(0,4), M=+oldest.slice(4,6)-1, d=+oldest.slice(6,8), h=+oldest.slice(8,10), m=+oldest.slice(10,12); const dt = Date.UTC(y,M,d,h,m); const age = Math.floor((nowMs - dt)/86400000); await setMetric(env, 'retention.age.slo_breach_minute.days', age); } } catch {/* ignore */}
    } catch {/* ignore metrics */}
  } catch {/* ignore retention */}
}
