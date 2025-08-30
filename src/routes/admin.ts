import { json, err } from '../lib/http';
import { audit } from '../lib/audit';
import type { Env } from '../lib/types';
import { router } from '../router';
import { runIncrementalIngestion } from '../lib/ingestion';

export function registerAdminRoutes() {
  router
    .add('GET','/admin/backfill', async ({ env, req }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const rs = await env.DB.prepare(`SELECT id, created_at, dataset, from_date, to_date, days, status, processed, total, error FROM backfill_jobs ORDER BY created_at DESC LIMIT 50`).all();
      return json({ ok:true, rows: rs.results||[] });
    })
    .add('GET','/admin/ingestion/provenance', async ({ env, req, url }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const dataset = (url.searchParams.get('dataset')||'').trim();
      const source = (url.searchParams.get('source')||'').trim();
      const status = (url.searchParams.get('status')||'').trim();
      let limit = parseInt(url.searchParams.get('limit')||'100',10); if (!Number.isFinite(limit)||limit<1) limit=100; if (limit>500) limit=500;
      const where:string[] = []; const binds:any[] = [];
      if (dataset) { where.push('dataset = ?'); binds.push(dataset); }
      if (source) { where.push('source = ?'); binds.push(source); }
      if (status) { where.push('status = ?'); binds.push(status); }
      const whereSql = where.length ? ('WHERE '+where.join(' AND ')) : '';
      const sql = `SELECT id,dataset,source,from_date,to_date,started_at,completed_at,status,rows,error FROM ingestion_provenance ${whereSql} ORDER BY started_at DESC LIMIT ?`;
      binds.push(limit);
      const rs = await env.DB.prepare(sql).bind(...binds).all();
      return json({ ok:true, rows: rs.results||[], filtered: { dataset: dataset||undefined, source: source||undefined, status: status||undefined, limit } });
    })
    .add('GET','/admin/ingestion/config', async ({ env, req }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      try {
        const rs = await env.DB.prepare(`SELECT dataset, source, cursor, enabled, last_run_at, meta FROM ingestion_config ORDER BY dataset, source`).all();
        return json({ ok:true, rows: rs.results||[] });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('POST','/admin/ingestion/config', async ({ env, req }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
      const dataset = (body.dataset||'').toString().trim();
      const source = (body.source||'').toString().trim();
      if (!dataset || !source) return json({ ok:false, error:'dataset_and_source_required' },400);
      const cursor = body.cursor !== undefined ? String(body.cursor) : null;
      const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
      const meta = body.meta !== undefined ? JSON.stringify(body.meta).slice(0,2000) : null;
      try {
        await env.DB.prepare(`INSERT OR REPLACE INTO ingestion_config (dataset,source,cursor,enabled,last_run_at,meta) VALUES (?,?,?,?,datetime('now'),?)`)
          .bind(dataset, source, cursor, enabled, meta).run();
        const row = await env.DB.prepare(`SELECT dataset, source, cursor, enabled, last_run_at, meta FROM ingestion_config WHERE dataset=? AND source=?`).bind(dataset, source).all();
        await audit(env, { actor_type:'admin', action:'upsert', resource:'ingestion_config', resource_id:`${dataset}:${source}`, details:{ cursor, enabled } });
        return json({ ok:true, row: row.results?.[0]||null });
      } catch (e:any) { return json({ ok:false, error:String(e) },500); }
    })
    .add('POST','/admin/ingestion/run', async ({ env, req }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body:any = await req.json().catch(()=>({}));
      const results = await runIncrementalIngestion(env, { maxDays: Number(body.maxDays)||1 });
      return json({ ok:true, runs: results });
    })
    .add('POST','/admin/ingest/prices', async ({ env, req }) => {
      if (req.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ ok:false, error:'forbidden' },403);
      const body = await req.json().catch(()=>({})) as any;
      const days = Math.min(30, Math.max(1, Number(body.days)||3));
      const to = new Date();
      const from = new Date(to.getTime() - (days-1)*86400000);
      const fromDate = from.toISOString().slice(0,10);
      const toDate = to.toISOString().slice(0,10);
      const cardRs = await env.DB.prepare(`SELECT id FROM cards LIMIT 50`).all();
      let cards = (cardRs.results||[]) as any[];
      if (!cards.length) {
        const cid = 'CARD-MOCK-1';
        await env.DB.prepare(`INSERT OR IGNORE INTO cards (id,name,set_id,set_name,number,rarity) VALUES (?,?,?,?,?,?)`).bind(cid,'Mock Card','mock','Mock Set','001','Promo').run();
        cards = [{ id: cid }];
      }
      const provId = crypto.randomUUID();
      try { await env.DB.prepare(`INSERT INTO ingestion_provenance (id,dataset,source,from_date,to_date,started_at,status,rows) VALUES (?,?,?,?,?,datetime('now'),'running',0)`).bind(provId,'prices_daily','external-mock',fromDate,toDate).run(); } catch {}
      let inserted = 0;
      try {
        for (let i=0;i<days;i++) {
          const d = new Date(from.getTime() + i*86400000).toISOString().slice(0,10);
          for (const c of cards) {
            const have = await env.DB.prepare(`SELECT 1 FROM prices_daily WHERE card_id=? AND as_of=?`).bind((c as any).id, d).all();
            if (have.results?.length) continue;
            const latest = await env.DB.prepare(`SELECT price_usd, price_eur FROM prices_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind((c as any).id).all();
            const pu = (latest.results?.[0] as any)?.price_usd || Math.random()*50+1;
            const pe = (latest.results?.[0] as any)?.price_eur || pu*0.9;
            await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind((c as any).id, d, pu, pe).run();
            inserted++;
          }
        }
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='completed', rows=?, completed_at=datetime('now') WHERE id=?`).bind(inserted, provId).run(); } catch {}
        return json({ ok:true, inserted, from_date: fromDate, to_date: toDate, provenance_id: provId });
      } catch (e:any) {
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='error', error=?, completed_at=datetime('now') WHERE id=?`).bind(String(e), provId).run(); } catch {}
        return err('ingest_failed', 500, { error_detail: String(e) });
      }
    });
}

registerAdminRoutes();
