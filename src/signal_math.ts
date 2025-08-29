// src/signal_math.ts
// Lightweight yet richer signal blend.
// Inputs: prices[] (USD preferred, falls back to EUR), svis[] (Google Trends)
// Enhancements:
//  - Theil–Sen slopes for robustness (ts7, ts30)
//  - Median Absolute Deviation (MAD) volatility
//  - Robust SVI z-score using median & MAD
//  - Drawdown & regime break retained
// Outputs: 0..100 score, BUY/HOLD/SELL, edgeZ, expected return, sd, components

type Out = {
  score: number;
  signal: 'BUY'|'HOLD'|'SELL';
  reasons: string[];
  edgeZ: number;
  expRet: number;
  expSd: number;
  components: {
    ts7: number|null;
    ts30: number|null;
    dd: number|null;
    vol: number|null;
    zSVI: number|null;
    regimeBreak: boolean;
  };
};

function mean(xs: number[]) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function median(xs: number[]) { if (!xs.length) return 0; const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : 0.5*(s[m-1]+s[m]); }
function mad(xs: number[]) { if (!xs.length) return 0; const m=median(xs); const dev=xs.map(x=>Math.abs(x-m)); return median(dev); }
function sd(xs: number[]) { if (xs.length<2) return 0; const m=mean(xs); const v=xs.reduce((a,b)=>a+(b-m)*(b-m),0)/(xs.length-1); return Math.sqrt(Math.max(0,v)); }
function robustZ(x: number, arr: number[]) { if (!arr.length) return 0; const m=median(arr); const mAD=mad(arr)||1e-9; return 0.6745*(x - m)/mAD; }
function classicZ(x: number, arr: number[]) { const s=sd(arr); if (!Number.isFinite(s)||s===0) return 0; return (x - mean(arr))/s; }
function theilSenSlope(series: number[]): number|null { // simple O(n^2) for small windows
  const n=series.length; if (n<2) return null; const slopes:number[]=[]; for (let i=0;i<n;i++) for (let j=i+1;j<n;j++) { const dy=series[j]-series[i]; const dx=(j-i)||1; slopes.push(dy/dx); }
  return median(slopes);
}
function last<T>(arr: T[]) { return arr.length ? arr[arr.length-1] : null; }
function pctChange(a: number, b: number) { return (b - a) / (Math.abs(a) || 1e-9); }

export function compositeScore(prices: number[], svis: number[]): Out {
  const reasons: string[] = [];
  const components = { ts7: null as number|null, ts30: null as number|null, dd: null as number|null, vol: null as number|null, zSVI: null as number|null, regimeBreak: false };

  // 1) Price momentum & risk
  let ts7 = 0, ts30 = 0, vol = 0, dd = 0;
  if (prices.length >= 7) {
    const rets: number[] = [];
    for (let i=1;i<prices.length;i++) rets.push(Math.log((prices[i] || 1e-9)/(prices[i-1] || 1e-9)));
    const annFactor = Math.sqrt(252);
    // Robust volatility: scale MAD of returns by 1.4826 (normal consistency)
    const madR = mad(rets);
    vol = (madR * 1.4826) * annFactor;
    const w7 = prices.slice(-7);
    const w30 = prices.slice(-Math.min(30, prices.length));
    const slope7 = theilSenSlope(w7);
    const slope30 = theilSenSlope(w30);
    ts7 = slope7 === null ? 0 : slope7 / (w7[0] || 1e-9); // normalize by first price
    ts30 = slope30 === null ? 0 : slope30 / (w30[0] || 1e-9);
    // drawdown (simple)
    let peak = -Infinity, maxdd = 0;
    for (const p of prices) { peak = Math.max(peak, p); maxdd = Math.max(maxdd, (peak - p)/(peak || 1e-9)); }
    dd = maxdd;
    components.ts7 = ts7; components.ts30 = ts30; components.vol = vol; components.dd = dd;
    reasons.push(`ts_slope7=${ts7.toFixed(4)}`, `ts_slope30=${ts30.toFixed(4)}`);
  }

  // 2) SVI z-score (search interest vs its history)
  if (svis.length >= 7) {
    const z = robustZ(last(svis) as number, svis);
    components.zSVI = z;
    reasons.push(`svi_rz=${z.toFixed(2)}`);
  } else {
    components.zSVI = null;
  }

  // 3) Regime break (very crude): if last return > 3 sd of history -> regimeBreak
  if (prices.length >= 20) {
    const rets: number[] = [];
    for (let i=1;i<prices.length;i++) rets.push(Math.log((prices[i] || 1e-9)/(prices[i-1] || 1e-9)));
    const z = classicZ(last(rets) as number, rets.slice(0,-1));
    if (Math.abs(z) >= 3) { components.regimeBreak = true; reasons.push('regime_break'); }
  }

  // 4) Blend into [0,100] score
  // weights: short-term momentum (0.45), longer trend (0.25), SVI (0.20), risk penalty (0.10)
  let wTs7 = 0.45, wTs30 = 0.25, wSVI = 0.20, wRisk = 0.10;
  let base = 50;
  if (components.ts7 !== null) base += 100 * wTs7 * components.ts7;
  if (components.ts30 !== null) base += 100 * wTs30 * components.ts30;
  if (components.zSVI !== null) base += 10  * wSVI * (components.zSVI as number); // z around -3..+3 -> -6..+6 contribution
  if (components.vol !== null)  base -= 10  * wRisk * (components.vol as number); // penalize high vol a bit

  // clamp
  const score = Math.max(0, Math.min(100, base));
  let signal: 'BUY'|'HOLD'|'SELL' = 'HOLD';
  if (score >= 66) signal = 'BUY';
  else if (score <= 33) signal = 'SELL';

  // map to crude expected return/sd (for display)
  const edgeZ = (score - 50)/15; // 0 -> 50, ±1 z around 15 pts
  const expRet = 0.001 * (score - 50);  // daily-ish expectation proxy
  const expSd  = Math.max(0.01, (components.vol ?? 0.2)/Math.sqrt(252));

  return { score: Math.round(score), signal, reasons, edgeZ, expRet, expSd, components };
}
