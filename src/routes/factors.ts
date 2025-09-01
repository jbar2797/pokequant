import { router } from '../router';
import { json, err } from '../lib/http';
import { ErrorCodes } from '../lib/errors';
import { audit } from '../lib/audit';
import type { Env } from '../lib/types';
import { computeFactorIC, computeFactorReturns } from '../lib/factors';
import { FactorWeightsSchema, validate, FactorConfigSchema, FactorToggleSchema, FactorDeleteSchema } from '../lib/validation';

function admin(env: Env, req: Request) { return req.headers.get('x-admin-token') === env.ADMIN_TOKEN; }

export function registerFactorRoutes() {
  router
    .add('POST','/admin/factor-weights', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const body: any = await req.json().catch(()=>({}));
      const parsed = validate(FactorWeightsSchema, body);
  if (!parsed.ok) return err(ErrorCodes.InvalidBody, 400, { details: parsed.errors });
      const version = (parsed.data.version || ('manual'+Date.now()));
      const weights = parsed.data.weights;
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_weights (version TEXT, factor TEXT, weight REAL, active INTEGER, created_at TEXT, PRIMARY KEY(version,factor));`).run();
      await env.DB.prepare(`UPDATE factor_weights SET active=0 WHERE active=1`).run();
      for (const w of weights) {
        const f = (w.factor||'').toString();
        const wt = Number(w.weight);
        if (!f || !Number.isFinite(wt)) continue;
        await env.DB.prepare(`INSERT OR REPLACE INTO factor_weights (version,factor,weight,active,created_at) VALUES (?,?,?,?,datetime('now'))`).bind(version,f,wt,1).run();
      }
      await audit(env, { actor_type:'admin', action:'upsert', resource:'factor_weights', resource_id:version, details:{ factors: weights.length } });
      return json({ ok:true, version, factors: weights.length });
    })
    .add('GET','/admin/factor-weights', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const rs = await env.DB.prepare(`SELECT version, factor, weight, active, created_at FROM factor_weights ORDER BY created_at DESC, factor ASC LIMIT 200`).all();
      return json({ ok:true, rows: rs.results||[] });
    })
    .add('POST','/admin/factor-weights/auto', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      let q = await env.DB.prepare(`SELECT factor, AVG(ABS(ic)) AS strength FROM factor_ic WHERE as_of >= date('now','-29 day') GROUP BY factor`).all();
      let rows = (q.results||[]) as any[];
      try { const { getFactorUniverse } = await import('../lib/factors'); const enabled = await getFactorUniverse(env); rows = rows.filter(r=> enabled.includes(String(r.factor))); } catch {/* ignore */}
      if (!rows.length) {
        await computeFactorIC(env);
        q = await env.DB.prepare(`SELECT factor, AVG(ABS(ic)) AS strength FROM factor_ic WHERE as_of >= date('now','-90 day') GROUP BY factor`).all();
        rows = (q.results||[]) as any[];
        try { const { getFactorUniverse } = await import('../lib/factors'); const enabled = await getFactorUniverse(env); rows = rows.filter(r=> enabled.includes(String(r.factor))); } catch {/* ignore */}
      }
      if (!rows.length) {
        const factorsFallback = ['ts7','ts30','z_svi'];
        rows = factorsFallback.map(f=> ({ factor: f, strength: 1 }));
      }
      const sum = rows.reduce((a,r)=> a + (Number(r.strength)||0),0) || 1;
      const genVersion = 'auto'+ new Date().toISOString().slice(0,19).replace(/[:T]/g,'').replace(/-/g,'');
      await env.DB.prepare(`UPDATE factor_weights SET active=0 WHERE active=1`).run();
      for (const r of rows) { const w = (Number(r.strength)||0)/sum; await env.DB.prepare(`INSERT OR REPLACE INTO factor_weights (version,factor,weight,active,created_at) VALUES (?,?,?,?,datetime('now'))`).bind(genVersion, r.factor, w, 1).run(); }
      await audit(env, { actor_type:'admin', action:'auto_weights', resource:'factor_weights', resource_id:genVersion, details:{ factors: rows.length } });
      return json({ ok:true, version: genVersion, factors: rows.length });
    })
    .add('POST','/admin/factor-ic/run', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const out = await computeFactorIC(env); await audit(env, { actor_type:'admin', action:'run', resource:'factor_ic', resource_id: (out as any).as_of||null }); return json(out);
    })
    .add('GET','/admin/factor-ic', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic ORDER BY as_of DESC, factor ASC LIMIT 300`).all(); return json({ ok:true, rows: rs.results||[] });
    })
    .add('GET','/admin/factor-ic/summary', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic WHERE as_of >= date('now','-90 day') ORDER BY factor ASC, as_of ASC`).all();
      const rows = (rs.results||[]) as any[]; const by: Record<string, number[]> = {};
      for (const r of rows) { const f=String(r.factor); const v=Number(r.ic); if (!Number.isFinite(v)) continue; (by[f] ||= []).push(v); }
      const out:any[]=[]; const avg=(a:number[])=> a.reduce((s,x)=>s+x,0)/a.length; const std=(a:number[])=> { const m=avg(a); let s=0; for(const x of a) s+=(x-m)*(x-m); return Math.sqrt(s/(a.length-1)); };
      for (const [f, arr] of Object.entries(by)) { const last30=arr.slice(-30), last7=arr.slice(-7); const mk=(vals:number[])=>{ if(!vals.length) return { n:0 }; const a=avg(vals); const sa = vals.reduce((s,x)=>s+Math.abs(x),0)/vals.length; const h=vals.filter(x=>x>0).length/vals.length; const st = vals.length>1? std(vals):0; const ir = (st>0)? (a/st)*Math.sqrt(252):null; return { n:vals.length, a:+a.toFixed(6), sa:+sa.toFixed(6), h:+h.toFixed(3), ir: ir!=null? +ir.toFixed(4): null }; };
        const all=mk(arr), w30=mk(last30), w7=mk(last7); out.push({ factor:f, n:all.n, avg_ic:all.a, avg_abs_ic:all.sa, hit_rate:all.h, ir:all.ir, avg_ic_30:w30.a, avg_abs_ic_30:w30.sa, hit_rate_30:w30.h, ir_30:w30.ir, avg_ic_7:w7.a, avg_abs_ic_7:w7.sa, hit_rate_7:w7.h, ir_7:w7.ir }); }
      return json({ ok:true, rows: out });
    })
    .add('GET','/admin/factor-returns', async ({ env, req }) => {
  if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403);
      const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now','-120 day') ORDER BY factor ASC, as_of ASC`).all();
      const rows = (rs.results||[]) as any[]; const by:Record<string,{d:string;r:number}[]>={}; for (const r of rows){ const f=String(r.factor); const ret=Number(r.ret); if(!Number.isFinite(ret)) continue; (by[f] ||= []).push({ d:String(r.as_of), r:ret }); }
      const aggregates:Record<string,any>={}; const compound=(rets:number[])=> rets.length? rets.reduce((p,x)=>p*(1+x),1)-1:null; const avg=(a:number[])=> a.length? a.reduce((s,x)=>s+x,0)/a.length:null; const std=(a:number[])=>{ if(a.length<2) return null; const m=avg(a)!; let s=0; for(const v of a) s+=(v-m)*(v-m); return Math.sqrt(s/(a.length-1)); };
      for (const f of Object.keys(by)) { const arr=by[f]; const last7=arr.slice(-7).map(o=>o.r); const last30=arr.slice(-30).map(o=>o.r); const c7=compound(last7); const c30=compound(last30); const a7=avg(last7); const a30=avg(last30); const vol30=std(last30); const sharpe30=(a30!=null && vol30 && vol30>0)? (a30/vol30)*Math.sqrt(252):null; aggregates[f]={ win7_compound:c7!=null?+c7.toFixed(6):null, win30_compound:c30!=null?+c30.toFixed(6):null, avg7:a7!=null?+a7.toFixed(6):null, avg30:a30!=null?+a30.toFixed(6):null, sharpe30:sharpe30!=null?+sharpe30.toFixed(4):null, points:arr.length }; }
      const recent = rows.slice().sort((a,b)=> (a.as_of===b.as_of ? (a.factor<b.factor?-1:1) : (a.as_of>b.as_of?-1:1))).slice(0,400);
      return json({ ok:true, rows: recent, aggregates });
    })
  .add('POST','/admin/factor-returns/run', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const out = await computeFactorReturns(env); await audit(env, { actor_type:'admin', action:'run', resource:'factor_returns', resource_id:(out as any).as_of||null }); return json(out); })
  .add('GET','/admin/factor-risk', async ({ env, req, url }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const day = url.searchParams.get('as_of') || new Date().toISOString().slice(0,10); const rs = await env.DB.prepare(`SELECT factor_i, factor_j, cov, corr FROM factor_risk_model WHERE as_of = ?`).bind(day).all(); return json({ ok:true, as_of: day, pairs: rs.results||[] }); })
  .add('GET','/admin/factor-metrics', async ({ env, req, url }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const day = url.searchParams.get('as_of') || new Date().toISOString().slice(0,10); const rs = await env.DB.prepare(`SELECT factor, vol, beta FROM factor_metrics WHERE as_of = ?`).bind(day).all(); return json({ ok:true, as_of: day, metrics: rs.results||[] }); })
  .add('GET','/admin/factor-returns-smoothed', async ({ env, req, url }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const day = url.searchParams.get('as_of') || new Date().toISOString().slice(0,10); const rs = await env.DB.prepare(`SELECT factor, ret_smoothed FROM factor_returns_smoothed WHERE as_of = ?`).bind(day).all(); return json({ ok:true, as_of: day, returns: rs.results||[] }); })
    .add('GET','/admin/signal-quality', async ({ env, req, url }) => { if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403); const day = url.searchParams.get('as_of') || new Date().toISOString().slice(0,10); const rs = await env.DB.prepare(`SELECT factor, ic_mean, ic_vol, ic_autocorr_lag1, ic_half_life FROM signal_quality_metrics WHERE as_of = ?`).bind(day).all(); return json({ ok:true, as_of: day, metrics: rs.results||[] }); })
  .add('GET','/admin/factor-performance', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const [fr, ic] = await Promise.all([ env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now','-120 day') ORDER BY factor ASC, as_of ASC`).all(), env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic WHERE as_of >= date('now','-120 day') ORDER BY factor ASC, as_of ASC`).all() ]); const frBy:Record<string,{d:string;r:number}[]>={}; for (const r of (fr.results||[]) as any[]) { const f=String(r.factor); const ret=Number(r.ret); if(!Number.isFinite(ret)) continue; (frBy[f] ||= []).push({ d:String(r.as_of), r:ret }); } const icBy:Record<string,{d:string;ic:number}[]>={}; for (const r of (ic.results||[]) as any[]) { const f=String(r.factor); const v=Number(r.ic); if(!Number.isFinite(v)) continue; (icBy[f] ||= []).push({ d:String(r.as_of), ic:v }); } const factors = Array.from(new Set([...Object.keys(frBy), ...Object.keys(icBy)])).sort(); const avg=(a:number[])=> a.length? a.reduce((s,x)=>s+x,0)/a.length:null; const std=(a:number[])=>{ if(a.length<2) return null; const m=avg(a)!; let s=0; for(const v of a) s+=(v-m)*(v-m); return Math.sqrt(s/(a.length-1)); }; const compound=(rets:number[])=> rets.length? rets.reduce((p,x)=>p*(1+x),1)-1:null; const out:any[]=[]; for (const f of factors) { const frArr=frBy[f]||[]; const icArr=icBy[f]||[]; const last30Ret=frArr.slice(-30).map(o=>o.r); const last7Ret=frArr.slice(-7).map(o=>o.r); const ret30C=compound(last30Ret); const ret7C=compound(last7Ret); const ret30Avg=avg(last30Ret); const ret30Std=std(last30Ret); const ret30Sharpe=(ret30Avg!=null && ret30Std && ret30Std>0)? (ret30Avg/ret30Std)*Math.sqrt(252):null; const ic30=icArr.slice(-30).map(o=>o.ic); const ic7=icArr.slice(-7).map(o=>o.ic); const ic30AbsAvg=ic30.length? ic30.reduce((s,x)=> s+Math.abs(x),0)/ic30.length:null; const weightSuggest=ic30AbsAvg!=null? ic30AbsAvg : (ic7.length? ic7.reduce((s,x)=> s+Math.abs(x),0)/ic7.length : null); out.push({ factor:f, ret_compound_30:ret30C!=null? +ret30C.toFixed(6):null, ret_compound_7:ret7C!=null? +ret7C.toFixed(6):null, sharpe30:ret30Sharpe!=null? +ret30Sharpe.toFixed(4):null, ic_avg_abs_30:ic30AbsAvg!=null? +ic30AbsAvg.toFixed(6):null, weight_suggest:weightSuggest!=null? +weightSuggest.toFixed(6):null }); } const sum = out.reduce((s,x)=> s + (x.weight_suggest||0),0); if (sum>0) { for (const o of out) o.weight_suggest = +(o.weight_suggest / sum).toFixed(6); } return json({ ok:true, factors: out }); })
  .add('GET','/admin/factors', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run(); const rs = await env.DB.prepare(`SELECT factor, enabled, display_name, created_at FROM factor_config ORDER BY factor ASC`).all(); return json({ ok:true, rows: rs.results||[] }); })
  .add('POST','/admin/factors', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const body:any = await req.json().catch(()=>({})); const parsed = validate(FactorConfigSchema, body); if (!parsed.ok) return err(ErrorCodes.InvalidBody, 400, { details: parsed.errors }); const { factor, enabled, display_name } = parsed.data; const enabledInt = enabled === undefined ? 1 : (enabled ? 1 : 0); await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run(); await env.DB.prepare(`INSERT OR REPLACE INTO factor_config (factor, enabled, display_name, created_at) VALUES (?,?,?, COALESCE((SELECT created_at FROM factor_config WHERE factor=?), datetime('now')))`).bind(factor, enabledInt, display_name||null, factor).run(); await audit(env, { actor_type:'admin', action:'upsert', resource:'factor_config', resource_id:factor, details:{ enabled: enabledInt } }); return json({ ok:true, factor, enabled: enabledInt, display_name: display_name||null }); })
  .add('POST','/admin/factors/toggle', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const body:any = await req.json().catch(()=>({})); const parsed=validate(FactorToggleSchema, body); if(!parsed.ok) return err(ErrorCodes.InvalidBody, 400, { details: parsed.errors }); const { factor, enabled } = parsed.data; const enabledInt = enabled?1:0; await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run(); await env.DB.prepare(`UPDATE factor_config SET enabled=? WHERE factor=?`).bind(enabledInt, factor).run(); await audit(env, { actor_type:'admin', action:'toggle', resource:'factor_config', resource_id:factor, details:{ enabled: enabledInt } }); return json({ ok:true, factor, enabled: enabledInt }); })
  .add('POST','/admin/factors/delete', async ({ env, req }) => { if (!admin(env, req)) return err(ErrorCodes.Forbidden, 403); const body:any = await req.json().catch(()=>({})); const parsed=validate(FactorDeleteSchema, body); if(!parsed.ok) return err(ErrorCodes.InvalidBody, 400, { details: parsed.errors }); const { factor } = parsed.data; await env.DB.prepare(`CREATE TABLE IF NOT EXISTS factor_config (factor TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, display_name TEXT, created_at TEXT);`).run(); await env.DB.prepare(`DELETE FROM factor_config WHERE factor=?`).bind(factor).run(); await audit(env, { actor_type:'admin', action:'delete', resource:'factor_config', resource_id:factor }); return json({ ok:true, factor }); })
    .add('GET','/admin/factor-correlations', async ({ env, req, url }) => { if (!admin(env, req)) return json({ ok:false, error:'forbidden' },403); const look = Math.min(180, Math.max(5, parseInt(url.searchParams.get('days')||'60',10))); try { const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ?) ORDER BY as_of ASC`).bind(`-${look-1} day`).all(); const rows = (rs.results||[]) as any[]; const by:Record<string,{d:string;r:number}[]>={}; for (const r of rows){ const f=String(r.factor); const d=String(r.as_of); const v=Number(r.ret); if(!Number.isFinite(v)) continue; (by[f] ||= []).push({ d, r:v }); } const factors = Object.keys(by).sort(); if (factors.length < 2) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:0 } }); const dateSets = factors.map(f=> new Set(by[f].map(o=> o.d))); const allDates = Array.from(new Set(rows.map(r=> String(r.as_of)))).sort(); const usable = allDates.filter(d=> dateSets.every(s=> s.has(d))); const series:number[][] = factors.map(()=> []); for (const d of usable){ factors.forEach((f,idx)=> { const v = by[f].find(o=> o.d===d)?.r; series[idx].push(v ?? 0); }); } const n=usable.length; if (n<5) return json({ ok:true, factors, matrix: [], stats:{ avg_abs_corr:null, days:n } }); const mean=(a:number[])=> a.reduce((s,x)=>s+x,0)/a.length; const corr=(a:number[],b:number[])=>{ const ma=mean(a), mb=mean(b); let num=0,da=0,db=0; for (let i=0;i<a.length;i++){ const x=a[i]-ma,y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; } const den=Math.sqrt(da*db)||0; return den? num/den:0; }; const matrix:number[][]=[]; for (let i=0;i<factors.length;i++){ matrix[i]=[]; for (let j=0;j<factors.length;j++){ matrix[i][j]=+(corr(series[i],series[j])).toFixed(4); } } let sumAbs=0, pairs=0; for (let i=0;i<matrix.length;i++) for (let j=i+1;j<matrix.length;j++){ sumAbs+=Math.abs(matrix[i][j]); pairs++; } const avgAbs = pairs? +(sumAbs/pairs).toFixed(4): null; return json({ ok:true, factors, days:n, matrix, stats:{ avg_abs_corr: avgAbs } }); } catch(e:any){ return json({ ok:false, error:String(e) },500); } });
}

registerFactorRoutes();
