import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import type { Env } from '../lib/types';
import { audit } from '../lib/audit';
import { computeAndStoreSignals } from '../lib/signals';
import { computeIntegritySnapshot, updateDataCompleteness } from '../lib/integrity';
import { log } from '../lib/log';
import { runAlerts } from '../lib/alerts_run';
import { computeFactorIC, computeFactorReturns, computeFactorRiskModel, smoothFactorReturns, computeSignalQuality } from '../lib/factors';
import { detectAnomalies } from '../lib/anomalies';
import { snapshotPortfolioNAV, computePortfolioPnL } from '../lib/portfolio_nav';
import { snapshotPortfolioFactorExposure } from '../lib/portfolio_exposure';
import { purgeOldData } from '../lib/retention';
import { incMetricBy, recordLatency } from '../lib/metrics';

function isAdmin(env: Env, req: Request) {
  const t = req.headers.get('x-admin-token');
  return !!(t && (t === env.ADMIN_TOKEN || (env.ADMIN_TOKEN_NEXT && t === env.ADMIN_TOKEN_NEXT)));
}

router
  // Backfill jobs list
  .add('GET','/admin/backfill', async ({ env, req }) => {
    if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    const rs = await env.DB.prepare(`SELECT id, created_at, dataset, from_date, to_date, days, status, processed, total, error FROM backfill_jobs ORDER BY created_at DESC LIMIT 50`).all();
    return json({ ok:true, rows: rs.results||[] });
  })
  // Diag snapshot
  .add('GET','/admin/diag', async ({ env, req }) => {
  if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    const [svi14, pr1, pr7, sigLast, lp, ls, lsv] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM svi_daily GROUP BY card_id HAVING COUNT(*) >= 14)`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 1)`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM prices_daily GROUP BY card_id HAVING COUNT(*) >= 7)`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT card_id FROM signals_daily WHERE as_of=(SELECT MAX(as_of) FROM signals_daily))`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM prices_daily`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM signals_daily`).all(),
      env.DB.prepare(`SELECT MAX(as_of) AS d FROM svi_daily`).all(),
    ]);
    return json({ ok:true, cards_with_svi14_plus: svi14.results?.[0]?.n ?? 0, cards_with_price1_plus: pr1.results?.[0]?.n ?? 0, cards_with_price7_plus: pr7.results?.[0]?.n ?? 0, signals_rows_latest: sigLast.results?.[0]?.n ?? 0, latest_price_date: lp.results?.[0]?.d ?? null, latest_signal_date: ls.results?.[0]?.d ?? null, latest_svi_date: lsv.results?.[0]?.d ?? null });
  })
  // Ingest Trends (GitHub Action)
  .add('POST','/ingest/trends', async ({ env, req }) => {
    if (req.headers.get('x-ingest-token') !== env.INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
    const body:any = await req.json().catch(()=>({}));
    const rows = body && Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ ok:true, rows:0 });
    const batch: D1PreparedStatement[] = [];
    for (const r of rows) batch.push(env.DB.prepare(`INSERT OR REPLACE INTO svi_daily (card_id, as_of, svi) VALUES (?,?,?)`).bind(r.card_id, r.as_of, r.svi));
    await env.DB.batch(batch);
    return json({ ok:true, rows: rows.length });
  })
  // Force legacy portfolio auth
  .add('POST','/admin/portfolio/force-legacy', async ({ env, req }) => {
    if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    const body:any = await req.json().catch(()=>({}));
    const pid = (body.id||'').toString();
    if (!pid) return err(ErrorCodes.IdRequired,400);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
      try { await env.DB.prepare(`ALTER TABLE portfolios ADD COLUMN secret_hash TEXT`).run(); } catch {/* ignore */}
      const row = await env.DB.prepare(`SELECT secret, secret_hash FROM portfolios WHERE id=?`).bind(pid).all();
      if (!row.results?.length) return err(ErrorCodes.NotFound,404);
      const hadHash = !!(row.results[0] as any).secret_hash;
      if (hadHash) await env.DB.prepare(`UPDATE portfolios SET secret_hash=NULL WHERE id=?`).bind(pid).run();
      await audit(env, { actor_type:'admin', action:'force_legacy', resource:'portfolio', resource_id:pid, details:{ hadHash } });
      return json({ ok:true, id: pid, had_hash: hadHash });
    } catch (e:any) { return json({ ok:false, error:String(e) },500); }
  })
  // Fast run (seed + signals only)
  .add('POST','/admin/run-fast', async ({ env, req }) => {
    if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    try {
      const today = new Date(); const todayStr = today.toISOString().slice(0,10);
      const cardCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all();
      if ((cardCount.results?.[0] as any)?.n === 0) {
        const cards = Array.from({length:12}).map((_,i)=> ({ id:`SEED-${i+1}`, name:`Seed Card ${i+1}`, set_name:'Seed', rarity:'Promo' }));
        for (let idx=0; idx<cards.length; idx++) {
          const c = cards[idx];
            await env.DB.prepare(`INSERT OR IGNORE INTO cards (id,name,set_name,rarity) VALUES (?,?,?,?)`).bind(c.id,c.name,c.set_name,c.rarity).run();
            for (let d=14; d>=0; d--) {
              const day = new Date(today.getTime() - d*86400000).toISOString().slice(0,10);
              const base = 10 + idx*1.5 + d * (0.5 + (idx%3)*0.1);
              await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind(c.id, day, base, base*0.9).run();
            }
        }
      } else {
        const existingToday = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`).bind(todayStr).all();
        if (!((existingToday.results||[])[0] as any)?.n) {
          const cards = await env.DB.prepare(`SELECT id FROM cards LIMIT 100`).all();
          let i = 0; for (const r of (cards.results||[]) as any[]) { const base = 20 + (i % 10) * 1.25; await env.DB.prepare(`INSERT OR IGNORE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES (?,?,?,?,datetime('now'))`).bind((r as any).id, todayStr, base, base*0.9).run(); i++; }
        }
      }
  const out = await computeAndStoreSignals(env, { limit: 150 });
  log('admin_run_fast', { ...out });
      return json({ ok:true, ...out });
    } catch (e:any) { log('admin_run_fast_error', { error:String(e) }); return json({ ok:false, error:String(e) },500); }
  })
  // Full pipeline (lightweight placeholder uses integrity snapshot only for now)
  .add('POST','/admin/run-now', async ({ env, req }) => {
    if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    try {
      const phases: { name:string; fn:()=>Promise<any> }[] = [
        { name:'signals', fn: ()=> computeAndStoreSignals(env, { limit: 250 }) },
        { name:'alerts', fn: ()=> runAlerts(env) },
        { name:'data_completeness', fn: ()=> updateDataCompleteness(env) },
        { name:'factor_ic', fn: ()=> computeFactorIC(env) },
        { name:'factor_returns', fn: ()=> computeFactorReturns(env) },
        { name:'risk_model', fn: ()=> computeFactorRiskModel(env) },
        { name:'returns_smoothed', fn: ()=> smoothFactorReturns(env) },
        { name:'signal_quality', fn: ()=> computeSignalQuality(env) },
        { name:'anomalies', fn: ()=> detectAnomalies(env) },
        { name:'portfolio_nav', fn: ()=> snapshotPortfolioNAV(env) },
        { name:'portfolio_pnl', fn: ()=> computePortfolioPnL(env) },
        { name:'portfolio_factor_exposure', fn: ()=> snapshotPortfolioFactorExposure(env) },
        { name:'retention', fn: async ()=> { const t0=Date.now(); const del=await purgeOldData(env); const ms=Date.now()-t0; for (const [table,n] of Object.entries(del)) if (n>0) incMetricBy(env, `retention.deleted.${table}`, n); recordLatency(env,'job.retention', ms); return { deleted: del }; } }
      ];
      const metrics:any = { phases:{} };
      const tAll = Date.now();
      for (const p of phases) { const t=Date.now(); try { const out = await p.fn(); metrics.phases[p.name] = { ms: Date.now()-t }; if (out && out.deleted) metrics.deleted = out.deleted; } catch (e:any){ metrics.phases[p.name] = { ms: Date.now()-t, error:String(e) }; } }
      metrics.total_ms = Date.now() - tAll;
      const integrity = await computeIntegritySnapshot(env);
      log('admin_run_pipeline', { integrity, metrics });
      return json({ ok:true, integrity, metrics });
    } catch (e:any) { log('admin_run_pipeline_error', { error:String(e) }); return json({ ok:false, error:String(e) },500); }
  })
  // Factor correlations (kept for backwards compatibility tests)
  .add('GET','/admin/factor-correlations', async ({ env, req, url }) => {
    if (!isAdmin(env, req)) return err(ErrorCodes.Forbidden,403);
    const look = Math.min(180, Math.max(5, parseInt(url.searchParams.get('days')||'60',10)));
    try {
      const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ?) ORDER BY as_of ASC`).bind(`-${look-1} day`).all();
      const rows = (rs.results||[]) as any[]; const byFactor: Record<string, {d:string; r:number}[]> = {};
      for (const r of rows) { const f=String(r.factor); const d=String(r.as_of); const v=Number(r.ret); if (!Number.isFinite(v)) continue; (byFactor[f] ||= []).push({ d, r:v }); }
      const factors = Object.keys(byFactor).sort(); if (factors.length < 2) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:0 } });
      const dateSets = factors.map(f=> new Set(byFactor[f].map(o=> o.d)));
      const allDates = Array.from(new Set(rows.map(r=> String(r.as_of)))).sort();
      const usable = allDates.filter(d=> dateSets.every(s=> s.has(d)));
      const series: number[][] = factors.map(()=> []);
      for (const d of usable) factors.forEach((f,idx)=> { const v = byFactor[f].find(o=> o.d===d)?.r; series[idx].push(v ?? 0); });
      const n = usable.length; if (n < 5) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:n } });
      const mean = (a:number[])=> a.reduce((s,x)=>s+x,0)/a.length;
      const corr = (a:number[], b:number[]) => { const ma=mean(a), mb=mean(b); let num=0,da=0,db=0; for (let i=0;i<a.length;i++){ const x=a[i]-ma,y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; } const den = Math.sqrt(da*db)||0; return den? num/den:0; };
      const matrix:number[][]=[]; for (let i=0;i<factors.length;i++){ matrix[i]=[]; for (let j=0;j<factors.length;j++){ matrix[i][j] = +(corr(series[i], series[j])).toFixed(4); } }
      let sumAbs=0,pairs=0; for (let i=0;i<matrix.length;i++) for (let j=i+1;j<matrix.length;j++){ sumAbs+=Math.abs(matrix[i][j]); pairs++; }
      const avgAbs = pairs? +(sumAbs/pairs).toFixed(4): null;
      return json({ ok:true, factors, days:n, matrix, stats:{ avg_abs_corr: avgAbs } });
    } catch (e:any) { return json({ ok:false, error:String(e) },500); }
  });

// File has no explicit export; importing it registers routes.