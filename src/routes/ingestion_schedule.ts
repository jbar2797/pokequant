import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import type { Env } from '../lib/types';
import { runIncrementalIngestion } from '../lib/ingestion';
import { incMetric } from '../lib/metrics';
import { IngestionScheduleSetSchema, validate } from '../lib/validation';
import { audit } from '../lib/audit';

function admin(env: Env, req: Request) { const t=req.headers.get('x-admin-token'); return !!(t && (t===env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t===env.ADMIN_TOKEN_NEXT))); }

export function registerIngestionScheduleRoutes() {
  router
    .add('GET','/admin/ingestion-schedule', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden,403); await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_schedule (dataset TEXT PRIMARY KEY, frequency_minutes INTEGER, last_run_at TEXT);`).run(); const rs = await env.DB.prepare(`SELECT dataset, frequency_minutes, last_run_at FROM ingestion_schedule ORDER BY dataset`).all(); return json({ ok:true, rows: rs.results||[] }); })
  .add('POST','/admin/ingestion-schedule', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden,403); const body:any = await req.json().catch(()=>({})); const parsed = validate(IngestionScheduleSetSchema, body); if(!parsed.ok) return err(ErrorCodes.InvalidBody,400,{ details: parsed.errors }); const { dataset, frequency_minutes } = parsed.data; await env.DB.prepare(`INSERT OR REPLACE INTO ingestion_schedule (dataset, frequency_minutes, last_run_at) VALUES (?,?,COALESCE((SELECT last_run_at FROM ingestion_schedule WHERE dataset=?), NULL))`).bind(dataset, frequency_minutes, dataset).run(); await audit(env, { actor_type:'admin', action:'set_schedule', resource:'ingestion_schedule', resource_id:dataset, details:{ freq: frequency_minutes } }); return json({ ok:true, dataset, frequency_minutes }); })
    .add('POST','/admin/ingestion-schedule/run-due', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden,403); await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingestion_schedule (dataset TEXT PRIMARY KEY, frequency_minutes INTEGER, last_run_at TEXT);`).run(); const nowIso = new Date().toISOString(); const dueRs = await env.DB.prepare(`SELECT dataset, frequency_minutes, last_run_at FROM ingestion_schedule`).all(); const due:string[]=[]; for (const r of (dueRs.results||[]) as any[]) { const last = r.last_run_at ? Date.parse(r.last_run_at) : 0; const mins = Number(r.frequency_minutes)||0; if (!mins) continue; if (Date.now() - last >= mins*60000) due.push(String(r.dataset)); } const body:any = await req.json().catch(()=>({})); const runFlag = body.run === true || body.run === 1 || body.run === '1'; for (const d of due) { await env.DB.prepare(`UPDATE ingestion_schedule SET last_run_at=? WHERE dataset=?`).bind(nowIso, d).run(); incMetric(env, 'ingest.scheduled_run'); } let ingestRuns:any[]|undefined; if (runFlag && due.length) { ingestRuns = await runIncrementalIngestion(env, { datasets: due, maxDays: 1 }); } return json({ ok:true, ran: due, ingested: ingestRuns }); });
}

registerIngestionScheduleRoutes();
