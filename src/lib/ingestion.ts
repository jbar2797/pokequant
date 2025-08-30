import { audit } from './audit';
import type { Env } from './types';

// Reusable incremental ingestion logic (extracted from monolithic index.ts)
// Generates synthetic price rows for configured datasets (currently only prices_daily) advancing cursor.
export async function runIncrementalIngestion(env: Env, options?: { datasets?: string[]; maxDays?: number }) {
  const maxDays = Math.min(7, Math.max(1, Number(options?.maxDays)||1));
  const filter = options?.datasets ? new Set(options.datasets) : null;
  const cfgRs = await env.DB.prepare(`SELECT dataset, source, cursor FROM ingestion_config WHERE enabled=1`).all();
  const configs = (cfgRs.results||[]) as any[];
  const today = new Date().toISOString().slice(0,10);
  const results: any[] = [];
  for (const c of configs) {
    const dataset = String(c.dataset||'');
    if (filter && !filter.has(dataset)) continue;
    const source = String(c.source||'');
    let cursor: string|null = c.cursor ? String(c.cursor) : null;
    let inserted = 0; let fromDate: string|null = null; let toDate: string|null = null; let status = 'skipped';
    if (dataset === 'prices_daily') {
      const startDate = cursor ? new Date(Date.parse(cursor) + 86400000) : new Date(Date.now() - (maxDays-1)*86400000);
      const dates: string[] = [];
      for (let i=0;i<maxDays;i++) {
        const d = new Date(startDate.getTime() + i*86400000).toISOString().slice(0,10);
        if (Date.parse(d) > Date.parse(today)) break;
        dates.push(d);
      }
      if (!dates.length || (cursor && cursor >= today)) {
        results.push({ dataset, source, skipped:true, cursor, status:'skipped' });
        continue;
      }
      fromDate = dates[0]; toDate = dates[dates.length-1];
      const provId = crypto.randomUUID();
      try { await env.DB.prepare(`INSERT INTO ingestion_provenance (id,dataset,source,from_date,to_date,started_at,status,rows) VALUES (?,?,?,?,?,datetime('now'),'running',0)`).bind(provId,dataset,source,fromDate,toDate).run(); } catch {/* ignore table missing */}
      try {
        const haveCards = await env.DB.prepare(`SELECT id FROM cards LIMIT 20`).all();
        let cards = (haveCards.results||[]) as any[];
        if (!cards.length) {
          const cid = 'INGEST-SEED-1';
          await env.DB.prepare(`INSERT OR IGNORE INTO cards (id,name,set_name,rarity) VALUES (?,?,?,?)`).bind(cid,'Ingest Seed Card','Ingest','Promo').run();
          cards = [{ id: cid }];
        }
        for (const d of dates) {
          for (const card of cards) {
            const exist = await env.DB.prepare(`SELECT 1 FROM prices_daily WHERE card_id=? AND as_of=?`).bind(card.id,d).all();
            if (exist.results?.length) continue;
            const seed = [...(card.id+d+source)].reduce((a,ch)=> a + ch.charCodeAt(0),0);
            const base = (seed % 120) + 3;
            await env.DB.prepare(`INSERT INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind(card.id,d,base,base*0.9).run();
            inserted++;
          }
        }
        cursor = toDate; status = 'completed';
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='completed', rows=?, completed_at=datetime('now') WHERE id=?`).bind(inserted, provId).run(); } catch {/* ignore */}
        await env.DB.prepare(`UPDATE ingestion_config SET cursor=?, last_run_at=datetime('now') WHERE dataset=? AND source=?`).bind(cursor,dataset,source).run();
        await audit(env, { actor_type:'admin', action:'ingest_incremental', resource:'ingestion_run', resource_id:`${dataset}:${source}`, details:{ fromDate, toDate, inserted, scheduled: !!filter } });
      } catch (e:any) {
        status = 'error';
        try { await env.DB.prepare(`UPDATE ingestion_provenance SET status='error', error=?, completed_at=datetime('now') WHERE id=?`).bind(String(e), provId).run(); } catch {/* ignore */}
        await audit(env, { actor_type:'admin', action:'ingest_error', resource:'ingestion_run', resource_id:`${dataset}:${source}`, details:{ error:String(e), scheduled: !!filter } });
      }
    }
    results.push({ dataset, source, inserted, from_date: fromDate, to_date: toDate, status, cursor });
  }
  return results;
}
