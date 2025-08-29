// src/signal_math.ts
// Robust, bounded scoring with SVI-only fallback support.

export type CompositeOut = {
  score: number;                       // 0..100
  signal: 'BUY' | 'HOLD' | 'SELL';
  reasons: string[];
  edgeZ: number;                       // normalized 'edge' proxy
  expRet: number;                      // heuristic expected return per period (bps, not displayed yet)
  expSd: number;                       // heuristic risk proxy (bps, not displayed yet)
  components: {
    ts7: number | null;                // short-term momentum proxy (prices)    [z-like]
    ts30: number | null;               // medium-term momentum proxy (prices)   [z-like]
    dd: number | null;                 // drawdown 0..1 (prices)                [0=none, 1=worst]
    vol: number | null;                // stdev of log-returns (prices)         [z-like]
    zSVI: number | null;               // z-score of SVI                        [z]
    regimeBreak: boolean;              // true if a break/phase-change detected
  }
};

const EPS = 1e-12;

function mean(xs: number[]): number {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
}
function stdev(xs: number[]): number {
  const v = xs.filter(Number.isFinite);
  if (v.length < 2) return 0;
  const m = mean(v);
  const s2 = v.reduce((a,b)=>a+(b-m)*(b-m),0)/(v.length-1);
  return Math.sqrt(Math.max(0, s2));
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
function zFrom(value: number, ref: number[], floor = 1e-6): number {
  const m = mean(ref);
  const sd = Math.max(stdev(ref), floor);
  return (value - m) / sd;
}
function ln(x: number): number {
  return Math.log(Math.max(x, EPS));
}
function last<T>(xs: T[]): T {
  return xs[xs.length-1];
}
function sliceLast(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs.slice();
  return xs.slice(xs.length - n);
}
function pctChange(a: number, b: number): number {
  // (b/a - 1)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return 0;
  return b / a - 1;
}
function linregSlopeZ(y: number[]): number {
  // Returns slope normalized by sd(y). Simple trend proxy for last ~8-12 points.
  const n = y.length;
  if (n < 3) return 0;
  const xs = Array.from({length:n}, (_,i)=>i+1);
  const mx = mean(xs);
  const my = mean(y);
  let num = 0, den = 0;
  for (let i=0;i<n;i++){
    num += (xs[i]-mx)*(y[i]-my);
    den += (xs[i]-mx)*(xs[i]-mx);
  }
  const slope = den>0 ? num/den : 0;
  const sd = Math.max(stdev(y), 1e-6);
  return slope / sd;
}

function priceFeatures(prices: number[]) {
  // Use last 30 bars max for robustness
  const p = prices.filter(Number.isFinite);
  const n = p.length;
  if (n < 2) {
    return { ts7: null, ts30: null, dd: null, vol: null };
  }
  const last30 = sliceLast(p, 30);
  const last7  = sliceLast(p, 7);
  const pLast  = last(p);

  // momentum: compare last price to average of short/medium windows, convert ~to z-like scale
  const ts7 = zFrom(pLast, last7);
  const ts30 = zFrom(pLast, last30);

  // drawdown: 1 - last/max
  const maxP = Math.max(...last30);
  const dd = clamp(1 - (pLast / Math.max(maxP, EPS)), 0, 1);

  // vol: stdev of log-returns (last 30)
  const rets: number[] = [];
  for (let i=1;i<last30.length;i++) {
    rets.push(ln(last30[i]) - ln(last30[i-1]));
  }
  const vol = stdev(rets); // already scale-like

  return { ts7, ts30, dd, vol };
}

function sviFeatures(svis: number[]) {
  const s = svis.filter(Number.isFinite);
  const n = s.length;
  if (n < 1) return { zSVI: null, slopeZ: null };
  const look = sliceLast(s, Math.min(90, n));  // up to 90 obs
  const zSVI = zFrom(last(look), look);
  const slopeZ = linregSlopeZ(sliceLast(s, Math.min(12, n)));
  return { zSVI, slopeZ };
}

function scoreFrom(
  pf: { ts7: number|null, ts30: number|null, dd: number|null, vol: number|null },
  sf: { zSVI: number|null, slopeZ: number|null },
  hasPrices: boolean,
  hasSVI: boolean
): { score: number, reasons: string[], edgeZ: number, expRet: number, expSd: number, regimeBreak: boolean } {

  let raw = 0;
  const reasons: string[] = [];
  let regimeBreak = false;

  if (hasPrices) {
    const ts7 = pf.ts7 ?? 0;
    const ts30= pf.ts30 ?? 0;
    const dd  = pf.dd ?? 0;
    const vol = pf.vol ?? 0;

    raw += 0.40 * clamp(ts7,  -3, 3);     if (ts7 > 0.5) reasons.push('px_momo7+');
    raw += 0.20 * clamp(ts30, -3, 3);     if (ts30> 0.5) reasons.push('px_momo30+');
    raw -= 0.20 * clamp(dd*3, 0, 3);      if (dd  > 0.3) reasons.push('dd-');
    raw -= 0.15 * clamp((vol*10), 0, 3);  if (vol > 0.08) reasons.push('vol-');

    // "regime break": very fresh up-move after a deep dd
    if (dd > 0.35 && ts7 > 0.8) regimeBreak = true;
  }

  if (hasSVI) {
    const zS = sf.zSVI ?? 0;
    const sZ = sf.slopeZ ?? 0;
    raw += 0.20 * clamp(zS,  -3, 3);   if (zS > 0.5) reasons.push('svi_z+');
    raw += 0.15 * clamp(sZ,  -3, 3);   if (sZ > 0.4) reasons.push('svi_momo+');
  }

  // map raw to 0..100; keep HOLD centered near 50, modest spread
  const score = clamp(50 + raw * 8, 0, 100);

  // crude 'edge' and expectations for display/research
  const edgeZ = clamp(raw, -3, 3);
  const expRet = edgeZ * 15;  // bps proxy
  const expSd  = 120;         // constant proxy (could scale with vol later)

  return { score, reasons, edgeZ, expRet, expSd, regimeBreak };
}

// ---- Public API ----

// Accepts short price history (0..N) and SVI history (0..N).
// If no prices (or <7), but SVI >=14, produce an SVI-only score.
// If prices >=7, produce a composite score (and use SVI if available).
export function compositeScore(prices: number[], svis: number[]): CompositeOut {
  const hasPrices = prices.filter(Number.isFinite).length >= 7;
  const hasSVI    = svis.filter(Number.isFinite).length   >= 14;

  if (!hasPrices && !hasSVI) {
    // Not enough info
    return {
      score: 50, signal: 'HOLD', reasons: ['insufficient_data'],
      edgeZ: 0, expRet: 0, expSd: 120,
      components: { ts7: null, ts30: null, dd: null, vol: null, zSVI: null, regimeBreak: false }
    };
  }

  const pf = hasPrices ? priceFeatures(prices) : { ts7: null, ts30: null, dd: null, vol: null };
  const sf = hasSVI    ? sviFeatures(svis)     : { zSVI: null, slopeZ: null };

  const { score, reasons, edgeZ, expRet, expSd, regimeBreak } =
    scoreFrom(pf, sf, hasPrices, hasSVI);

  const signal = score >= 60 ? 'BUY' : score <= 40 ? 'SELL' : 'HOLD';

  return {
    score,
    signal,
    reasons,
    edgeZ,
    expRet,
    expSd,
    components: {
      ts7: pf.ts7, ts30: pf.ts30, dd: pf.dd, vol: pf.vol,
      zSVI: sf.zSVI,
      regimeBreak
    }
  };
}
