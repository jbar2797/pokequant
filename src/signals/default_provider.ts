import type { SignalsProvider, SignalComputeOptions, SignalComputeResult } from './index';
import type { Env } from '../lib/types';
import { log } from '../lib/log';

interface PriceRow { card_id: string; as_of: string; price_usd: number }

function linearSlope(rows: PriceRow[]): number|null {
  if (rows.length < 3) return null;
  let n = rows.length; let sumX=0,sumY=0,sumXY=0,sumXX=0;
  for (let i=0;i<n;i++) { const y = rows[i].price_usd; if (!Number.isFinite(y)) return null; sumX+=i; sumY+=y; sumXY+=i*y; sumXX+=i*i; }
  const den = n*sumXX - sumX*sumX; if (!den) return null; return (n*sumXY - sumX*sumY)/den;
}

function madLogRet(rows: PriceRow[]): number|null {
  if (rows.length < 5) return null;
  const rets:number[] = [];
  for (let i=1;i<rows.length;i++) { const a=rows[i-1].price_usd, b=rows[i].price_usd; if (a>0 && b>0) rets.push(Math.log(b/a)); }
  if (!rets.length) return null;
  const sorted = rets.slice().sort((a,b)=>a-b);
  const med = sorted[Math.floor(sorted.length/2)];
  const devs = rets.map(r=> Math.abs(r-med)).sort((a,b)=>a-b);
  const mad = devs[Math.floor(devs.length/2)];
  return mad;
}

export const DefaultSignalsProvider: SignalsProvider = {
  name: 'default_v1',
  async compute(env: Env, opts?: SignalComputeOptions): Promise<SignalComputeResult> {
    const today = new Date().toISOString().slice(0,10);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id,as_of));`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signal_components_daily (card_id TEXT, as_of DATE, ts7 REAL, ts30 REAL, dd REAL, vol REAL, z_svi REAL, regime_break INTEGER, liquidity REAL, scarcity REAL, mom90 REAL, PRIMARY KEY(card_id,as_of));`).run();
    } catch {/* ignore */}
    const rs = await env.DB.prepare(`SELECT id FROM cards ORDER BY id ASC LIMIT ?`).bind(opts?.limit || 250).all();
    const cards = (rs.results||[]) as any[];
    let idsProcessed = 0, wroteSignals = 0;
    for (const c of cards) {
      const id = String((c as any).id);
      const prs = await env.DB.prepare(`SELECT card_id, as_of, price_usd FROM prices_daily WHERE card_id=? ORDER BY as_of ASC LIMIT 90`).bind(id).all();
      const prices = (prs.results||[]) as any[] as PriceRow[];
      if (!prices.length) continue;
      const latest = prices[prices.length-1];
      if (latest.as_of !== today) continue;
      idsProcessed++;
      const last7 = prices.slice(-7);
      const last30 = prices.slice(-30);
      const slope7 = linearSlope(last7);
      const slope30 = linearSlope(last30);
      let peak = -Infinity; let dd = 0; for (const r of prices) { if (r.price_usd > peak) peak = r.price_usd; }
      if (peak > 0) dd = (peak - latest.price_usd)/peak;
      const vol = madLogRet(last30);
      const liquidity = prices.length;
      const scarcity = 1/Math.max(1, prices.length);
      const mom90 = slope30 ?? slope7 ?? 0;
      const z_svi = 0;
      const norm = latest.price_usd || 1;
      const slope7n = slope7 ? slope7 / norm : 0;
      const slope30n = slope30 ? slope30 / norm : 0;
      const volAdj = vol ? Math.max(0.0001, vol) : 0.0001;
      const rawScore = 50 * slope7n + 30 * slope30n - 10 * dd;
      const score = rawScore / (1 + 5*volAdj);
      const signal = score > 0.5 ? 'BUY' : score < -0.5 ? 'SELL' : 'HOLD';
      const edge_z = score; const exp_ret = score/10; const exp_sd = volAdj*5;
      const reasons: string[] = [];
      if (signal==='BUY') reasons.push('positive_trend'); else if (signal==='SELL') reasons.push('negative_trend'); if (dd>0.2) reasons.push('drawdown');
      try {
        await env.DB.prepare(`INSERT OR REPLACE INTO signal_components_daily (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break, liquidity, scarcity, mom90) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, today, slope7, slope30, dd, vol, z_svi, 0, liquidity, scarcity, mom90).run();
        await env.DB.prepare(`INSERT OR REPLACE INTO signals_daily (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(id, today, score, signal, JSON.stringify(reasons), edge_z, exp_ret, exp_sd).run();
        wroteSignals++;
      } catch (e:any) { log('signal_write_error', { card_id: id, error:String(e) }); }
    }
    return { idsProcessed, wroteSignals, provider: 'default_v1' };
  }
};
