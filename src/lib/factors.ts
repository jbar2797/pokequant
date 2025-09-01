import type { Env } from './types';
import { log } from './log';
import { mean as avg, covariance as covar, pearson, rankIC as rankICHelper } from './factor_math';

// Dynamic factor universe helper (persisted in factor_config). Falls back to default list.
export async function getFactorUniverse(env: Env): Promise<string[]> {
	try {
		const rs = await env.DB.prepare(`SELECT factor FROM factor_config WHERE enabled=1`).all();
		const rows = (rs.results||[]) as any[];
		if (rows.length) return rows.map(r=> String(r.factor));
	} catch {/* ignore */}
	return ['ts7','ts30','z_svi','risk','liquidity','scarcity','mom90'];
}

// Factor returns: compute top-bottom quintile forward return per enabled factor (using previous day factor values and forward price move)
export async function computeFactorReturns(env: Env) {
	try {
		const factorUniverse = await getFactorUniverse(env);
		if (!factorUniverse.length) return { ok:false, skipped:true };
		const meta = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest)) SELECT (SELECT d FROM prev) AS prev_d, (SELECT d FROM latest) AS latest_d`).all();
		const mrow = (meta.results||[])[0] as any; if (!mrow?.prev_d || !mrow?.latest_d) return { ok:false, skipped:true };
		const prevDay = mrow.prev_d as string; const nextDay = mrow.latest_d as string;
		const existing = await env.DB.prepare(`SELECT COUNT(*) AS c FROM factor_returns WHERE as_of=?`).bind(prevDay).all();
		if (((existing.results||[])[0] as any)?.c >= factorUniverse.length) return { ok:true, skipped:true };
		const rs = await env.DB.prepare(`SELECT sc.card_id, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90,
			(SELECT price_usd FROM prices_daily WHERE card_id=sc.card_id AND as_of=?) AS px_prev,
			(SELECT price_usd FROM prices_daily WHERE card_id=sc.card_id AND as_of=?) AS px_next
			FROM signal_components_daily sc WHERE sc.as_of=?`).bind(prevDay, nextDay, prevDay).all();
		const rows = (rs.results||[]) as any[]; if (!rows.length) return { ok:false, skipped:true };
		const forwardRet = (r:any)=> { const a=Number(r.px_prev)||0; const b=Number(r.px_next)||0; return (a>0 && b>0)? (b-a)/a : null; };
		const factorValue = (r:any, f:string) => { if (f==='risk') return r.vol; return r[f]; };
		for (const factor of factorUniverse) {
			const usable = rows.filter(r=> Number.isFinite(factorValue(r,factor)) && Number.isFinite(forwardRet(r)));
			if (usable.length < 10) continue;
			const sorted = usable.slice().sort((a,b)=> Number(factorValue(a,factor)) - Number(factorValue(b,factor)));
			const q = Math.max(1, Math.floor(sorted.length/5));
			const bottom = sorted.slice(0,q);
			const top = sorted.slice(-q);
			const avg = (arr:any[])=> arr.reduce((s,x)=> s + (forwardRet(x)||0),0)/(arr.length||1);
			const ret = avg(top) - avg(bottom);
			await env.DB.prepare(`INSERT OR REPLACE INTO factor_returns (as_of, factor, ret) VALUES (?,?,?)`).bind(prevDay, factor, ret).run();
		}
		return { ok:true, as_of: prevDay };
	} catch (e) { log('factor_returns_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}

// Factor risk model (covariance & correlation) + rolling vol/beta
export async function computeFactorRiskModel(env: Env) {
	try {
		const lookDays = 60;
		const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ?) ORDER BY as_of ASC`).bind(`-${lookDays-1} day`).all();
		const rows = (rs.results||[]) as any[];
		if (!rows.length) return { ok:false, skipped:true };
		const byFactor: Record<string,{d:string;r:number}[]> = {};
		for (const r of rows) { const f=String(r.factor); const d=String(r.as_of); const v=Number(r.ret); if (!Number.isFinite(v)) continue; (byFactor[f] ||= []).push({ d, r:v }); }
		const factors = Object.keys(byFactor).sort(); if (factors.length<1) return { ok:false, skipped:true };
		const dateSets = factors.map(f=> new Set(byFactor[f].map(o=> o.d)));
		const allDates = Array.from(new Set(rows.map(r=> String(r.as_of)))).sort();
		const usable = allDates.filter(d=> dateSets.every(s=> s.has(d)));
		if (usable.length < 10) return { ok:false, skipped:true };
		const series: Record<string, number[]> = {};
		for (const f of factors) series[f] = usable.map(d=> byFactor[f].find(o=> o.d===d)!.r);
		const market: number[] = []; for (let i=0;i<usable.length;i++){ let s=0; for (const f of factors) s+= series[f][i]; market.push(s/factors.length); }
		const mMean = avg(market); let mVar=0; for (const v of market) mVar+=(v-mMean)*(v-mMean); mVar /= (market.length-1); const mVarSafe = mVar || 1e-9;
		for (const f of factors) {
			const vol = Math.sqrt(Math.max(0, covar(series[f], series[f])));
			const beta = covar(series[f], market)/mVarSafe;
			await env.DB.prepare(`INSERT OR REPLACE INTO factor_metrics (as_of, factor, vol, beta) VALUES (date('now'), ?, ?, ?)`).bind(f, vol, beta).run();
		}
		for (let i=0;i<factors.length;i++) {
			for (let j=i;j<factors.length;j++) {
				const fi = factors[i], fj = factors[j];
				const c = covar(series[fi], series[fj]);
				const vi = covar(series[fi], series[fi]);
				const vj = covar(series[fj], series[fj]);
				const corr = (vi>0 && vj>0)? c/Math.sqrt(vi* vj) : 0;
				await env.DB.prepare(`INSERT OR REPLACE INTO factor_risk_model (as_of, factor_i, factor_j, cov, corr) VALUES (date('now'), ?, ?, ?, ?)`).bind(fi, fj, c, corr).run();
			}
		}
		return { ok:true, factors: factors.length };
	} catch (e) { log('risk_model_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}

// Bayesian smoothing of factor returns (simple shrink to grand mean)
export async function smoothFactorReturns(env: Env) {
	try {
		const look = 90;
		const rs = await env.DB.prepare(`SELECT as_of, factor, ret FROM factor_returns WHERE as_of >= date('now', ?) ORDER BY as_of ASC`).bind(`-${look-1} day`).all();
		const rows = (rs.results||[]) as any[]; if (!rows.length) return { ok:false, skipped:true };
		const byFactor: Record<string, number[]> = {};
		for (const r of rows) { const f=String(r.factor); const v=Number(r.ret); if (!Number.isFinite(v)) continue; (byFactor[f] ||= []).push(v); }
		const allVals: number[] = []; for (const v of Object.values(byFactor)) allVals.push(...v);
		if (!allVals.length) return { ok:false, skipped:true };
		const globalMean = allVals.reduce((s,x)=>s+x,0)/allVals.length;
		const globalVar = allVals.reduce((s,x)=> s+(x-globalMean)*(x-globalMean),0)/(allVals.length-1 || 1);
		const priorMean = globalMean; const priorVar = globalVar;
		const today = new Date().toISOString().slice(0,10);
		for (const [f, vals] of Object.entries(byFactor)) {
			const n = vals.length; const sampleMean = vals.reduce((s,x)=>s+x,0)/n;
			const sampleVar = vals.reduce((s,x)=> s+(x-sampleMean)*(x-sampleMean),0)/(n-1 || 1);
			const k = Math.max(1, Math.round( (sampleVar>0? sampleVar: priorVar) / (priorVar || 1e-6) ));
			const weight = n / (n + k);
			const shrunk = weight*sampleMean + (1-weight)*priorMean;
			await env.DB.prepare(`INSERT OR REPLACE INTO factor_returns_smoothed (as_of, factor, ret_smoothed) VALUES (?,?,?)`).bind(today, f, shrunk).run();
		}
		return { ok:true };
	} catch (e) { log('smooth_factor_returns_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}

// Signal quality metrics (IC stability & half-life)
export async function computeSignalQuality(env: Env) {
	try {
		const rs = await env.DB.prepare(`SELECT as_of, factor, ic FROM factor_ic WHERE as_of >= date('now','-89 day') ORDER BY as_of ASC`).all();
		const rows = (rs.results||[]) as any[]; if (!rows.length) return { ok:false, skipped:true };
		const byFactor: Record<string,{d:string;ic:number}[]> = {};
		for (const r of rows) { const f=String(r.factor); const v=Number(r.ic); if (!Number.isFinite(v)) continue; (byFactor[f] ||= []).push({ d:String(r.as_of), ic:v }); }
		const today = new Date().toISOString().slice(0,10);
		for (const [f, arr] of Object.entries(byFactor)) {
			if (arr.length < 5) continue;
			const ics = arr.map(o=> o.ic);
			const mean = ics.reduce((s,x)=>s+x,0)/ics.length;
			const vol = Math.sqrt(Math.max(0, ics.reduce((s,x)=> s+(x-mean)*(x-mean),0)/(ics.length-1)));
			let num=0,den=0; for (let i=1;i<ics.length;i++){ num += (ics[i]-mean)*(ics[i-1]-mean); }
			for (const v of ics) den += (v-mean)*(v-mean);
			const ac1 = den? num/den : 0;
			const phi = Math.min(0.999, Math.max(-0.999, ac1));
			const halfLife = phi<=0 ? null : Math.log(0.5)/Math.log(phi);
			await env.DB.prepare(`INSERT OR REPLACE INTO signal_quality_metrics (as_of, factor, ic_mean, ic_vol, ic_autocorr_lag1, ic_half_life) VALUES (?,?,?,?,?,?)`)
				.bind(today, f, mean, vol, ac1, halfLife).run();
		}
		return { ok:true };
	} catch (e) { log('signal_quality_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}

// Factor IC computation (rank IC prev-day factors vs forward return)
export async function computeFactorIC(env: Env) {
	try {
		const meta = await env.DB.prepare(`WITH latest AS (SELECT MAX(as_of) AS d FROM prices_daily), prev AS (SELECT MAX(as_of) AS d FROM prices_daily WHERE as_of < (SELECT d FROM latest)) SELECT (SELECT d FROM prev) AS prev_d, (SELECT d FROM latest) AS latest_d`).all();
		const metaRow = (meta.results||[])[0] as any;
		if (!metaRow || !metaRow.prev_d || !metaRow.latest_d) return { ok:false, skipped:true };
		const prevDay = metaRow.prev_d as string;
		const latestDay = metaRow.latest_d as string;
		const factorUniverse = await getFactorUniverse(env);
		const existing = await env.DB.prepare(`SELECT COUNT(*) AS c FROM factor_ic WHERE as_of=?`).bind(prevDay).all();
		if (((existing.results||[])[0] as any)?.c >= factorUniverse.length) return { ok:true, skipped:true, already:true };
		const rs = await env.DB.prepare(`SELECT p.card_id,
				p.price_usd AS px_prev,
				(SELECT price_usd FROM prices_daily WHERE card_id=p.card_id AND as_of=?) AS px_next,
				sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90
			FROM prices_daily p
			LEFT JOIN signal_components_daily sc ON sc.card_id=p.card_id AND sc.as_of=?
			WHERE p.as_of=?
			ORDER BY p.card_id
			LIMIT 600`).bind(latestDay, prevDay, prevDay).all();
		const rows = (rs.results||[]) as any[];
		if (!rows.length) return { ok:false, skipped:true };
		const rets: number[] = [];
		for (const r of rows) { const a = Number(r.px_prev)||0, b=Number(r.px_next)||0; rets.push(a>0 && b>0 ? (b-a)/a : 0); }
		if (rets.filter(x=>x!==0).length < 3) return { ok:false, skipped:true };
		function rankIC(fvals: number[]): number|null { return rankICHelper(fvals, rets); }
		const baseMaps: Record<string, number[]> = {
			ts7: rows.map(r=> Number(r.ts7)),
			ts30: rows.map(r=> Number(r.ts30)),
			z_svi: rows.map(r=> Number(r.z_svi)),
			risk: rows.map(r=> Number(r.vol)),
			liquidity: rows.map(r=> Number(r.liquidity)),
			scarcity: rows.map(r=> Number(r.scarcity)),
			mom90: rows.map(r=> Number(r.mom90))
		};
		const factors: Record<string, number|null> = {};
		for (const f of factorUniverse) { if (baseMaps[f]) factors[f] = rankIC(baseMaps[f]); }
		for (const [f, ic] of Object.entries(factors)) { if (ic === null) continue; await env.DB.prepare(`INSERT OR REPLACE INTO factor_ic (as_of,factor,ic) VALUES (?,?,?)`).bind(prevDay, f, ic).run(); }
		return { ok:true, factors, as_of: prevDay, forward_to: latestDay };
	} catch (e) { log('factor_ic_error', { error:String(e) }); return { ok:false, error:String(e) }; }
}

