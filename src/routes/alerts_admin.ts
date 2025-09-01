import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import type { Env } from '../lib/types';
import { runAlerts } from '../lib/alerts_run';
import { ensureAlertsTable, getAlertThresholdCol } from '../lib/data';
import { audit } from '../lib/audit';
import { incMetric, incMetricBy, setMetric, recordLatency } from '../lib/metrics';
import { EMAIL_RETRY_MAX, sendEmail } from '../email_adapter';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerAdminAlertRoutes() {
  router
    .add('POST','/admin/run-alerts', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      try {
        const gAny: any = globalThis as any;
        if (!gAny.__RUN_ALERTS_STATE) gAny.__RUN_ALERTS_STATE = { promise: null as Promise<any>|null, last: 0 };
        const ras = gAny.__RUN_ALERTS_STATE as { promise: Promise<any>|null; last:number };
        const now = Date.now(); const STALE_MS = 250;
        if (!ras.promise) {
          ras.promise = (async () => { try { return await runAlerts(env); } finally { ras.last = Date.now(); ras.promise = null; } })();
        } else if (now - ras.last > STALE_MS) {
          ras.promise = (async () => { try { return await runAlerts(env); } finally { ras.last = Date.now(); ras.promise = null; } })();
        }
        const out = await ras.promise; return json({ ok:true, ...out });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('GET','/admin/alerts', async ({ env, req, url }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      await ensureAlertsTable(env);
      const email = (url.searchParams.get('email')||'').trim();
      const active = url.searchParams.get('active');
      const suppressed = url.searchParams.get('suppressed');
      const where: string[]=[]; const binds:any[]=[];
      if (email) { where.push('email=?'); binds.push(email); }
      if (active === '1' || active === '0') { where.push('active=?'); binds.push(Number(active)); }
      if (suppressed === '1') { where.push('suppressed_until IS NOT NULL AND suppressed_until > datetime(\'now\')'); }
      if (suppressed === '0') { where.push('(suppressed_until IS NULL OR suppressed_until < datetime(\'now\'))'); }
      const sql = `SELECT id,email,card_id,kind,active,${await getAlertThresholdCol(env)} AS threshold,suppressed_until,last_fired_at,fired_count FROM alerts_watch ${where.length? 'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC LIMIT 200`;
      const rs = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok:true, rows: rs.results||[] });
    })
    .add('GET','/admin/alerts/stats', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      await ensureAlertsTable(env);
      const rs = await env.DB.prepare(`SELECT active, suppressed_until, fired_count FROM alerts_watch`).all();
      let total=0, activeCount=0, suppressed=0; let ge5=0, ge10=0, ge25=0;
      for (const r of (rs.results||[]) as any[]) {
        total++; const act = Number(r.active)||0; if (act) activeCount++;
        const sup = r.suppressed_until && Date.parse(String(r.suppressed_until)) > Date.now(); if (sup) suppressed++;
        const fc = Number(r.fired_count)||0; if (fc>=5) ge5++; if (fc>=10) ge10++; if (fc>=25) ge25++;
      }
      return json({ ok:true, total, active: activeCount, suppressed, active_unsuppressed: activeCount - suppressed, escalation:{ ge5, ge10, ge25 } });
    })
    .add('POST','/admin/alert-queue/send', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden,403);
      const t0 = Date.now();
      try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alert_email_queue (id TEXT PRIMARY KEY, created_at TEXT, email TEXT, card_id TEXT, kind TEXT, threshold_usd REAL, status TEXT, sent_at TEXT, attempt_count INTEGER DEFAULT 0, last_error TEXT);`).run(); } catch {}
      const rs = await env.DB.prepare(`SELECT id FROM alert_email_queue WHERE status='queued' ORDER BY created_at ASC LIMIT 50`).all();
      const ids = (rs.results||[]).map((r:any)=> r.id);
      let sentCount=0, retryCount=0, giveupCount=0;
      for (const id of ids) {
        const rowRes = await env.DB.prepare(`SELECT email, card_id, kind, threshold_usd, attempt_count FROM alert_email_queue WHERE id=?`).bind(id).all();
        const row:any = rowRes.results?.[0]; if (!row) continue;
        if (Number(row.attempt_count) >= EMAIL_RETRY_MAX) {
          await env.DB.prepare(`UPDATE alert_email_queue SET status='error', last_error=COALESCE(last_error,'max_attempts'), sent_at=datetime('now') WHERE id=?`).bind(id).run();
          giveupCount++; continue;
        }
        const subj = `PokeQuant Alert: ${row.card_id} ${row.kind} ${row.threshold_usd}`; const bodyHtml = `<p>Card <b>${row.card_id}</b> triggered <b>${row.kind}</b> at threshold ${row.threshold_usd}.</p>`;
        const sendRes = await sendEmail(env, row.email, subj, bodyHtml);
        if (sendRes.ok) {
          await env.DB.prepare(`UPDATE alert_email_queue SET status='sent', sent_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?`).bind(id).run(); sentCount++;
        } else {
          const attemptsSql = `UPDATE alert_email_queue SET attempt_count=attempt_count+1, last_error=?, sent_at=CASE WHEN attempt_count+1>=? THEN datetime('now') ELSE sent_at END, status=CASE WHEN attempt_count+1>=? THEN 'error' ELSE 'queued' END WHERE id=?`;
          await env.DB.prepare(attemptsSql).bind(sendRes.error||'error', EMAIL_RETRY_MAX, EMAIL_RETRY_MAX, id).run();
          if ((Number(row.attempt_count)+1) >= EMAIL_RETRY_MAX) giveupCount++; else retryCount++;
        }
        try {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_deliveries (id TEXT PRIMARY KEY, queued_id TEXT, email TEXT, subject TEXT, provider TEXT, ok INTEGER, error TEXT, attempt INTEGER, created_at TEXT, sent_at TEXT, provider_message_id TEXT);`).run();
          const attemptNum = Number(row.attempt_count)+1; const did = crypto.randomUUID();
          try { await env.DB.prepare(`ALTER TABLE email_deliveries ADD COLUMN provider_error_code TEXT`).run(); } catch {}
          await env.DB.prepare(`INSERT INTO email_deliveries (id, queued_id, email, subject, provider, ok, error, attempt, created_at, sent_at, provider_message_id, provider_error_code) VALUES (?,?,?,?,?,?,?,?,datetime('now'), CASE WHEN ? THEN datetime('now') ELSE NULL END, ?, ?)`).bind(did, id, row.email, subj, sendRes.provider||'none', sendRes.ok?1:0, sendRes.error||null, attemptNum, sendRes.ok?1:0, sendRes.id||null, sendRes.provider_error_code||null).run();
        } catch {/* ignore */}
      }
      if (sentCount) incMetric(env, 'alert.sent');
      if (retryCount) incMetricBy(env, 'email.retry', retryCount);
      if (giveupCount) incMetricBy(env, 'email.giveup', giveupCount);
      try {
        const depthRs = await env.DB.prepare(`SELECT COUNT(*) AS c FROM alert_email_queue WHERE status='queued'`).all();
        const depth = Number((depthRs.results||[])[0]?.c)||0;
        await setMetric(env, 'alert.queue.depth', depth);
        await recordLatency(env, 'lat.alert.queue.process', Date.now() - t0);
      } catch {/* ignore */}
      await audit(env, { actor_type:'admin', action:'process', resource:'alert_email_queue', resource_id:null, details:{ processed: ids.length, sent: sentCount, retry: retryCount, giveup: giveupCount } });
      return json({ ok:true, processed: ids.length, sent: sentCount, retry: retryCount, giveup: giveupCount });
    });
}

registerAdminAlertRoutes();
