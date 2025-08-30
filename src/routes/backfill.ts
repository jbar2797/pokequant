import { router } from '../router';
import { json } from '../lib/http';
import { audit } from '../lib/audit';
import type { Env } from '../lib/types';

function admin(env: Env, req: Request) { return req.headers.get('x-admin-token') === env.ADMIN_TOKEN; }

export function registerBackfillRoutes() {
  router
    .add('POST','/admin/backfill', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const body: any = await req.json().catch(()=>({}));
      const dataset = (body.dataset||'prices_daily').toString();
      const days = Math.min(365, Math.max(1, Number(body.days)||30));
      const to = new Date();
      const from = new Date(Date.now() - (days-1)*86400000);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO backfill_jobs (id, created_at, dataset, from_date, to_date, days, status, processed, total) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id, new Date().toISOString(), dataset, from.toISOString().slice(0,10), to.toISOString().slice(0,10), days, 'pending', 0, days).run();
      const provId = crypto.randomUUID();
      try {
        await env.DB.prepare(`INSERT INTO ingestion_provenance (id,dataset,source,from_date,to_date,started_at,status,rows) VALUES (?,?,?,?,?,datetime('now'),'running',0)`).bind(provId, dataset, 'synthetic-backfill', from.toISOString().slice(0,10), to.toISOString().slice(0,10)).run();
      } catch {}
      try {
        let insertedRows = 0;
        for (let i=0;i<days;i++) {
          const d = new Date(from.getTime() + i*86400000).toISOString().slice(0,10);
            if (dataset === 'prices_daily') {
              const cards = await env.DB.prepare(`SELECT id FROM cards LIMIT 50`).all();
              for (const c of (cards.results||[]) as any[]) {
                const have = await env.DB.prepare(`SELECT 1 FROM prices_daily WHERE card_id=? AND as_of=?`).bind((c as any).id, d).all();
                if (have.results?.length) continue;
                const latest = await env.DB.prepare(`SELECT price_usd, price_eur FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind((c as any).id).all();
                const pu = (latest.results?.[0] as any)?.price_usd || Math.random()*50+1;
                const pe = (latest.results?.[0] as any)?.price_eur || pu*0.9;
                await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind((c as any).id, d, pu, pe).run();
                insertedRows++;
              }
            }
          await env.DB.prepare(`UPDATE backfill_jobs SET processed=? WHERE id=?`).bind(i+1, id).run();
        }
        await env.DB.prepare(`UPDATE backfill_jobs SET status='completed' WHERE id=?`).bind(id).run();
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='completed', rows=?, completed_at=datetime('now') WHERE id=?`).bind(insertedRows, provId).run(); } catch {}
        await audit(env, { actor_type:'admin', action:'backfill_complete', resource:'backfill_job', resource_id:id, details:{ dataset, days, insertedRows } });
      } catch (e:any) {
        await env.DB.prepare(`UPDATE backfill_jobs SET status='error', error=? WHERE id=?`).bind(String(e), id).run();
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='error', error=?, completed_at=datetime('now') WHERE id=?`).bind(String(e), provId).run(); } catch {}
        await audit(env, { actor_type:'admin', action:'backfill_error', resource:'backfill_job', resource_id:id, details:{ dataset, error:String(e) } });
      }
      const job = await env.DB.prepare(`SELECT * FROM backfill_jobs WHERE id=?`).bind(id).all();
      return json({ ok:true, job: job.results?.[0] });
    })
    .add('GET','/admin/backfill', async ({ env, req }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const rows = await env.DB.prepare(`SELECT id, created_at, dataset, from_date, to_date, days, status, processed, total, error FROM backfill_jobs ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rows.results||[] });
    })
    .add('GET','/admin/backfill/:id', async ({ env, req, url }) => {
      if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403);
      const id = url.pathname.split('/').pop();
      const row = await env.DB.prepare(`SELECT * FROM backfill_jobs WHERE id=?`).bind(id).all();
      return json({ ok:true, job: row.results?.[0]||null });
    });
}

registerBackfillRoutes();
