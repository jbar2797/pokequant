import type { Env } from './types';
import { isoDaysAgo } from './date';

export async function runBacktest(env: Env, params: { lookbackDays?: number, txCostBps?: number, slippageBps?: number }) {
  const look = params.lookbackDays ?? 90;
  const txCostBps = params.txCostBps ?? 0;
  const slippageBps = params.slippageBps ?? 0;
  const since = isoDaysAgo(look);
  const rs = await env.DB.prepare(`SELECT s.card_id, s.as_of, s.score,
    (SELECT price_usd FROM prices_daily p WHERE p.card_id=s.card_id AND p.as_of=s.as_of) AS px
    FROM signals_daily s WHERE s.as_of >= ? ORDER BY s.as_of ASC, s.score DESC`).bind(since).all();
  const rows = (rs.results||[]) as any[];
  if (!rows.length) return { ok:false, error:'no_data' };
  const byDay = new Map<string, any[]>();
  for (const r of rows) { const d = String(r.as_of); const arr = byDay.get(d)||[]; if (arr.length < 150) { arr.push(r); byDay.set(d, arr); } }
  const dates = Array.from(byDay.keys()).sort();
  let equity = 1; const curve: { d:string; equity:number; spreadRet:number }[] = [];
  let maxEquity = 1; let maxDrawdown = 0; let sumSpread = 0; let sumSqSpread = 0; let nSpread = 0;
  let prevTopIds: string[] = []; let prevBottomIds: string[] = []; let turnoverSum = 0; let turnoverDays = 0;
  for (let i=1;i<dates.length;i++) {
    if (curve.length >= 60) break; // runtime guard
    const todayD = dates[i]; const arr = byDay.get(todayD)||[]; if (arr.length < 10) continue;
    const q = Math.floor(arr.length/5)||1; const top = arr.slice(0,q); const bottom = arr.slice(-q);
    const avg = (xs:number[])=> xs.reduce((a,b)=>a+b,0)/(xs.length||1);
    const topPx = avg(top.map(r=> Number(r.px)||0)); const bottomPx = avg(bottom.map(r=> Number(r.px)||0));
    const prevArr = byDay.get(dates[i-1])||[]; const prevTopPx = avg(prevArr.slice(0,q).map(r=> Number(r.px)||0)); const prevBottomPx = avg(prevArr.slice(-q).map(r=> Number(r.px)||0));
    if (prevTopPx>0 && prevBottomPx>0 && topPx>0 && bottomPx>0) {
      const retTop = (topPx - prevTopPx)/prevTopPx; const retBottom = (bottomPx - prevBottomPx)/prevBottomPx;
      let spread = retTop - retBottom;
      if (txCostBps > 0) spread -= (txCostBps/10000)*2;
      if (slippageBps > 0) spread -= (slippageBps/10000)*2;
      equity *= (1 + spread); maxEquity = Math.max(maxEquity, equity); const dd = (maxEquity - equity)/maxEquity; if (dd > maxDrawdown) maxDrawdown = dd;
      sumSpread += spread; sumSqSpread += spread*spread; nSpread++;
      const topIds = top.map(r=> String(r.card_id)); const bottomIds = bottom.map(r=> String(r.card_id));
      if (prevTopIds.length === topIds.length) {
        const changedTop = topIds.filter(id=> !prevTopIds.includes(id)).length / (topIds.length||1);
        const changedBottom = bottomIds.filter(id=> !prevBottomIds.includes(id)).length / (bottomIds.length||1);
        turnoverSum += (changedTop + changedBottom)/2; turnoverDays++;
      }
      prevTopIds = topIds; prevBottomIds = bottomIds;
      curve.push({ d: todayD, equity: +equity.toFixed(6), spreadRet: +spread.toFixed(6) });
    }
  }
  const avgSpread = nSpread ? sumSpread / nSpread : 0; const volSpread = nSpread ? Math.sqrt(Math.max(0, (sumSqSpread/nSpread) - avgSpread*avgSpread)) : 0;
  const sharpe = volSpread ? (avgSpread/volSpread) * Math.sqrt(252) : 0; const turnover = turnoverDays ? turnoverSum / turnoverDays : 0;
  const metrics = { final_equity: equity, days: curve.length, avg_daily_spread: avgSpread, spread_vol: volSpread, sharpe, max_drawdown: maxDrawdown, turnover, truncated: dates.length>60 };
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO backtests (id, created_at, params, metrics, equity_curve) VALUES (?,?,?, ?, ? )`)
    .bind(id, new Date().toISOString(), JSON.stringify(params), JSON.stringify(metrics), JSON.stringify(curve)).run();
  return { ok:true, id, metrics, points: curve.length };
}
