// src/signal_math.ts
// Lightweight, transparent signal blend for MVP
// Inputs: prices[] (USD preferred, falls back to EUR), svis[] (Google Trends)
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
function sd(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs); const v = xs.reduce((a,b)=>a+(b-m)*(b-m),0)/(xs.length-1); return Math.sqrt(Math.max(0, v));
}
function zscore(x: number, arr: number[]) {
  const s = sd(arr); if (!Number.isFinite(s) || s === 0) return 0;
  return (x - mean(arr)) / s;
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
    vol = sd(rets) * Math.sqrt(252); // annualized-ish
    const m7 = prices.slice(-7);
    const m30 = prices.slice(-Math.min(30, prices.length));
    ts7 = pctChange(m7[0], m7[m7.length-1]);
    ts30 = pctChange(m30[0], m30[m30.length-1]);
    // drawdown (simple)
    let peak = -Infinity, maxdd = 0;
    for (const p of prices) { peak = Math.max(peak, p); maxdd = Math.max(maxdd, (peak - p)/(peak || 1e-9)); }
    dd = maxdd;
    components.ts7 = ts7; components.ts30 = ts30; components.vol = vol; components.dd = dd;
    reasons.push(`px_mom7=${ts7.toFixed(3)}`, `px_mom30=${ts30.toFixed(3)}`);
  }

  // 2) SVI z-score (search interest vs its history)
  if (svis.length >= 7) {
    const z = zscore(last(svis) as number, svis);
    components.zSVI = z;
    reasons.push(`svi_z=${z.toFixed(2)}`);
  } else {
    components.zSVI = null;
  }

  // 3) Regime break (very crude): if last return > 3 sd of history -> regimeBreak
  if (prices.length >= 20) {
    const rets: number[] = [];
    for (let i=1;i<prices.length;i++) rets.push(Math.log((prices[i] || 1e-9)/(prices[i-1] || 1e-9)));
    const z = zscore(last(rets) as number, rets.slice(0,-1));
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
