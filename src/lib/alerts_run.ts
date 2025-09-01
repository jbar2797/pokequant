import { ensureAlertsTable, getAlertThresholdCol } from './data';
import { incMetric, setMetric, recordLatency } from './metrics';
import type { Env } from './types';
import { log } from './log';

// Extracted from index.ts to enable modular routing.
export async function runAlerts(env: Env) {
  if ((env as any).FAST_TESTS === '1') {
    await ensureAlertsTable(env); // ensure schema for tests
    return { checked: 0, fired: 0 };
  }
  await ensureAlertsTable(env);
  const col = await getAlertThresholdCol(env);
  const rs = await env.DB.prepare(`
  SELECT a.id, a.email, a.card_id, a.kind, a.${col} as threshold,
           (SELECT COALESCE(price_usd, price_eur) FROM prices_daily p WHERE p.card_id=a.card_id ORDER BY as_of DESC LIMIT 1) AS px
    FROM alerts_watch a
  WHERE a.active=1 AND (a.suppressed_until IS NULL OR a.suppressed_until < datetime('now'))
  `).all();
  let fired = 0;
  const firedAlerts: any[] = [];
  const startAll = Date.now();
  for (const a of (rs.results ?? []) as any[]) {
    const px = Number(a.px);
    const th = Number(a.threshold);
    if (!Number.isFinite(px) || !Number.isFinite(th)) continue;
    const kind = String(a.kind || 'price_below');
    const hit = (kind === 'price_below') ? (px <= th) : (px >= th);
    if (!hit) continue;
    await env.DB.prepare(`UPDATE alerts_watch SET last_fired_at=datetime('now'), fired_count=COALESCE(fired_count,0)+1 WHERE id=?`).bind(a.id).run();
    try {
      const escRow = await env.DB.prepare(`SELECT fired_count FROM alerts_watch WHERE id=?`).bind(a.id).all();
      const fc = Number((escRow.results||[])[0]?.fired_count)||0;
      if (fc===5||fc===10||fc===25) await incMetric(env, 'alert.escalation');
    } catch {/* ignore */}
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_email_queue (id TEXT PRIMARY KEY, created_at TEXT, email TEXT, card_id TEXT, kind TEXT, threshold_usd REAL, status TEXT, sent_at TEXT);`).run();
      const qid = crypto.randomUUID();
      const qStart = Date.now();
      await env.DB.prepare(`INSERT INTO alert_email_queue (id, created_at, email, card_id, kind, threshold_usd, status) VALUES (?,?,?,?,?,?,?)`).bind(qid, new Date().toISOString(), a.email, a.card_id, kind, th, 'queued').run();
      await recordLatency(env, 'lat.alert.queue.enqueue', Date.now() - qStart);
      await incMetric(env, 'alert.queued');
      try {
        // Gauge current queue depth after enqueue
        const depthRs = await env.DB.prepare(`SELECT COUNT(*) AS c FROM alert_email_queue WHERE status='queued'`).all();
        const depth = Number((depthRs.results||[])[0]?.c)||0;
        await setMetric(env, 'alert.queue.depth', depth);
      } catch {/* ignore */}
    } catch {/* ignore */}
    fired++;
    firedAlerts.push({ id:a.id, email:a.email, card_id:a.card_id, kind, threshold:th, price:px });
  }
  try { await recordLatency(env, 'lat.alert.run.total', Date.now() - startAll); } catch {/* ignore */}
  if (firedAlerts.length) {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_endpoints (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT, active INTEGER DEFAULT 1, created_at TEXT);`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT, event TEXT, payload TEXT, ok INTEGER, status INTEGER, error TEXT, created_at TEXT);`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT, event TEXT, payload TEXT, ok INTEGER, status INTEGER, error TEXT, created_at TEXT, attempt INTEGER, duration_ms INTEGER);`).run();
      const wrs = await env.DB.prepare(`SELECT id,url,secret FROM webhook_endpoints WHERE active=1`).all();
      const MAX_ATTEMPTS = 3;
      for (const w of (wrs.results||[]) as any[]) {
        for (const alert of firedAlerts) {
          const payload = { type:'alert.fired', alert };
          let payloadText: string;
          try { payloadText = JSON.stringify(payload); } catch { payloadText = '{"type":"alert.fired"}'; }
          const nonceRaw = crypto.randomUUID();
          const nonce = nonceRaw.replace(/-/g,''); // spec: UUID w/o dashes
          const ts = Math.floor(Date.now()/1000);
          let signature: string | undefined; // HMAC(secret, ts.nonce.sha256(body))
          if (w.secret) {
            try {
              const enc = new TextEncoder();
              const bodyHashBuf = await crypto.subtle.digest('SHA-256', enc.encode(payloadText));
              const bodyHash = Array.from(new Uint8Array(bodyHashBuf)).map(b=> b.toString(16).padStart(2,'0')).join('');
              const canonical = `${ts}.${nonce}.${bodyHash}`;
              const key = await crypto.subtle.importKey('raw', enc.encode(w.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
              const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
              signature = Array.from(new Uint8Array(sigBuf)).map(b=> b.toString(16).padStart(2,'0')).join('');
            } catch {/* ignore – non-fatal */}
          }
          let failN = 0; let alwaysFail = false;
          if (env.WEBHOOK_REAL_SEND !== '1') {
            try {
              const u = new URL(w.url);
              const f = u.searchParams.get('fail');
              if (f) { const n = parseInt(f,10); if (Number.isFinite(n) && n>0) failN = Math.min(n, MAX_ATTEMPTS); }
              alwaysFail = u.searchParams.get('always_fail') === '1';
            } catch {/* ignore */}
          }
          let finalOutcomeRecorded = false;
          for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
            let ok = 1, status = 200, error: string|undefined; let duration = 0;
            const base = 250; const exp = Math.pow(2, attempt-1); const jitter = Math.floor(Math.random()*50);
            const plannedBackoff = attempt === 1 ? 0 : (base * exp + jitter);
            if (env.WEBHOOK_REAL_SEND === '1') {
              const tSend = Date.now();
              try {
                const headers: Record<string,string> = { 'content-type':'application/json' };
                if (signature) {
                  // New spec headers (lowercase); retain legacy x-signature-* for transition if consumers already integrated.
                  headers['x-webhook-signature'] = signature;
                  headers['x-webhook-timestamp'] = String(ts);
                  headers['x-webhook-nonce'] = nonce;
                  // Legacy (will deprecate):
                  headers['x-signature'] = signature;
                  headers['x-signature-ts'] = String(ts);
                  headers['x-signature-nonce'] = nonce;
                }
                const resp = await fetch(w.url, { method: 'POST', headers, body: payloadText });
                status = resp.status; ok = resp.ok ? 1 : 0; if (!resp.ok) error = `status_${resp.status}`;
              } catch (e:any) { ok=0; status=0; error=String(e); }
              duration = Date.now() - tSend;
            } else {
              if (alwaysFail || (failN && attempt <= failN)) { ok=0; status=0; error='sim_fail'; }
            }
            const did = crypto.randomUUID();
            try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN nonce TEXT`).run(); } catch {}
            try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN planned_backoff_ms INTEGER`).run(); } catch {}
            try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN signature TEXT`).run(); } catch {}
            try { await env.DB.prepare(`ALTER TABLE webhook_deliveries ADD COLUMN sig_ts INTEGER`).run(); } catch {}
            await env.DB.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event, payload, ok, status, error, created_at, attempt, duration_ms, nonce, planned_backoff_ms) VALUES (?,?,?,?,?,?,?,datetime('now'),?,?,?,?)`).bind(did, w.id, 'alert.fired', payloadText, ok, status, error||null, attempt, duration||null, nonce, plannedBackoff).run();
            // Update signature columns if present
            if (signature) {
              try { await env.DB.prepare(`UPDATE webhook_deliveries SET signature=?, sig_ts=? WHERE id=?`).bind(signature, ts, did).run(); } catch {/* ignore */}
            }
            if (ok) {
              if (env.WEBHOOK_REAL_SEND === '1') {
                if (attempt === 1) await incMetric(env, 'webhook.sent.real'); else await incMetric(env, 'webhook.retry_success.real');
              } else {
                if (attempt === 1) await incMetric(env, 'webhook.sent'); else await incMetric(env, 'webhook.retry_success');
              }
              finalOutcomeRecorded = true; break;
            } else if (attempt === MAX_ATTEMPTS) {
              await incMetric(env, env.WEBHOOK_REAL_SEND === '1' ? 'webhook.error.real' : 'webhook.error');
              finalOutcomeRecorded = true;
            }
          }
          if (!finalOutcomeRecorded) {/* no-op */}
        }
      }
    } catch (e) { log('webhook_dispatch_error', { error:String(e) }); }
  }
  return { checked: (rs.results ?? []).length, fired };
}
