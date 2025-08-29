// src/signal_math.ts
// Composite signal engine with SVI-only fallback.
// Produces score (0..100), signal, reasons, and component features.
//
// Design:
// - If price history >= 7 days: use price + SVI features.
// - If price history < 7 days but SVI >= 14 days: use SVI-only (lower confidence baked in).
// - If neither is sufficient: return HOLD/neutral and reasons state "insufficient data".

export type Signal = 'BUY' | 'HOLD' | 'SELL';

export interface CompositeOutput {
  score: number;            // 0..100
  signal: Signal;
  reasons: string[];
  edgeZ: number;            // blended "edge" z-ish summary (unitless)
  expRet: number;           // 1-day expected return proxy (unitless)
  expSd: number;            // 1-day expected volatility proxy (unitless)
  components: {
    ts7: number | null;     // short-term trend t-like stat on log-price
    ts30: number | null;    // medium-term trend
    dd: number | null;      // max drawdown (fraction 0..1) over window
    vol: number | null;     // realized vol (stdev of log returns, daily)
    zSVI: number | null;    // z-score of SVI vs baseline
    regimeBreak: boolean;   // crude regime-change indicator
  };
}

function clip(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
function mean(a: number[]) {
  const v = a.filter(Number.isFinite);
  if (!v.length) return 0;
  return v.reduce((s, x) => s + x, 0) / v.length;
}
function stdev(a: number[]) {
  const v = a.filter(Number.isFinite);
  if (v.length < 2) return 0;
  const m = mean(v);
  const s2 = v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1);
  return Math.sqrt(Math.max(s2, 0));
}
function logDiffs(p: number[]) {
  const out: number[] = [];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)) {
      out.push(Math.log(b) - Math.log(a));
    }
  }
  return out;
}
// OLS slope on last N points, normalized by residual scale ≈ t-stat proxy
function slopeT(y: number[]) {
  const n = y.length;
  if (n < 3) return 0;
  // x = 0..n-1, normalize x to zero-mean for numerical stability
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = (n - 1) / 2;
  const my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx;
    num += x * (y[i] - my);
    den += x * x;
  }
  if (den === 0) return 0;
  const slope = num / den;
  // scale slope by y-stdev to make it unitless-ish (t-like)
  const sdy = stdev(y);
  const t = sdy > 0 ? (slope * (n - 1)) / sdy : 0;
  return clip(t, -10, 10);
}

// Max drawdown over last W prices (compute on linear prices)
function maxDrawdown(p: number[]) {
  if (p.length < 3) return 0;
  let peak = p[0];
  let mdd = 0;
  for (let i = 1; i < p.length; i++) {
    peak = Math.max(peak, p[i]);
    if (peak > 0) {
      const dd = (peak - p[i]) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  return clip(mdd, 0, 0.99);
}

function lastN<T>(a: T[], n: number) {
  return a.slice(Math.max(0, a.length - n));
}

// Map blended edge to 0..100 score
function edgeToScore(edgeZ: number) {
  // Keep simple & smooth: center 50, slope ~15 per z-unit, clamp ±3
  return Math.round(50 + 15 * clip(edgeZ, -3, 3));
}

export function compositeScore(prices: number[], svis: number[]): CompositeOutput {
  const px = prices.filter(Number.isFinite);
  const sv = svis.filter(Number.isFinite);

  const hasPrice = px.length >= 7;
  const hasSVI   = sv.length >= 14;

  // --- Price features (if available) ---
  let ts7: number | null = null;
  let ts30: number | null = null;
  let vol: number | null = null;
  let dd: number | null = null;
  let regimeBreak = false;

  if (hasPrice) {
    const lp = px.map(v => Math.log(v));
    const lp7  = lastN(lp, Math.min(7, lp.length));
    const lp30 = lastN(lp, Math.min(30, lp.length));
    ts7  = slopeT(lp7);       // short-term trend t-ish
    ts30 = slopeT(lp30);      // medium-term trend t-ish

    const r21 = lastN(logDiffs(px), Math.min(21, Math.max(2, px.length - 1)));
    vol = stdev(r21);         // realized daily vol over ~1 month

    dd = maxDrawdown(lastN(px, Math.min(60, px.length)));

    // regime break: sharp vol spike or trend divergence
    const v7  = stdev(lastN(logDiffs(px), Math.min(7, Math.max(2, px.length - 1))));
    const v30 = stdev(lastN(logDiffs(px), Math.min(30, Math.max(2, px.length - 1))));
    const div = Math.abs((ts7 || 0) - (ts30 || 0));
    regimeBreak = (v30 > 0 && v7 / v30 > 2.5) || (div > 2.5);
  }

  // --- SVI features (if available) ---
  let zSVI: number | null = null;
  let sviTrend: number | null = null;
  if (hasSVI) {
    const baseWin = Math.min(90, sv.length);
    const base = lastN(sv, baseWin);
    const mu = mean(base), sd = stdev(base);
    zSVI = sd > 1e-9 ? (sv[sv.length - 1] - mu) / sd : 0;
    sviTrend = slopeT(lastN(sv, Math.min(21, sv.length))); // ~1-month trend
  }

  // --- Blend into an edge proxy ---
  // Normalize price risk features to z-ish scales:
  // volZ: assume 0.03 is "typical" daily stdev, 0.02 step size
  const volZ = hasPrice && vol != null ? (vol - 0.03) / 0.02 : 0;
  // ddZ: penalize deeper drawdowns (0..1) into negative territory
  const ddZ  = hasPrice && dd  != null ? -4.0 * dd : 0;

  const priceEdge = hasPrice
    ? (0.8 * (ts7 || 0)) + (0.4 * (ts30 || 0)) - (0.3 * volZ) + (0.25 * ddZ)
    : 0;

  const sviEdge = hasSVI
    ? (0.9 * (zSVI || 0)) + (0.6 * (sviTrend || 0))
    : 0;

  const wPrice = hasPrice ? (hasSVI ? 0.65 : 1.0) : 0.0;
  const wSVI   = hasSVI   ? (hasPrice ? 0.35 : 1.0) : 0.0;

  const edgeZ = wPrice * priceEdge + wSVI * sviEdge;

  const score = edgeToScore(edgeZ);
  const signal: Signal = score >= 62 ? 'BUY' : (score <= 38 ? 'SELL' : 'HOLD');

  // --- Reasons (explainability) ---
  const reasons: string[] = [];
  if (!hasPrice && hasSVI) reasons.push('SVI‑only signal (no price history yet)');
  if (!hasPrice && !hasSVI) reasons.push('Insufficient data; default HOLD');

  if (hasPrice) {
    if ((ts7 || 0) > 0.5) reasons.push('Short‑term uptrend');
    if ((ts30 || 0) > 0.5) reasons.push('Medium‑term uptrend');
    if ((dd  || 0) > 0.25) reasons.push('Deep prior drawdown');
    if (vol && vol > 0.05) reasons.push('High volatility');
  }
  if (hasSVI) {
    if ((zSVI || 0) > 1.5) reasons.push('Strong search momentum');
    if ((zSVI || 0) < -1)  reasons.push('Weakening interest');
    if ((sviTrend || 0) > 0.75) reasons.push('SVI rising trend');
  }
  if (regimeBreak) reasons.push('Regime break (volatility spike/divergence)');

  // --- Simple expRet/expSd proxies ---
  const expRet = hasPrice
    ? 0.002 * (ts7 || 0) + 0.0005 * (ts30 || 0) + 0.0005 * (zSVI || 0)
    : 0.001 * (zSVI || 0);

  const expSd = hasPrice ? Math.max(vol || 0.03, 0.01) : 0.03;

  return {
    score,
    signal,
    reasons,
    edgeZ,
    expRet,
    expSd,
    components: {
      ts7,
      ts30,
      dd,
      vol,
      zSVI,
      regimeBreak
    }
  };
}
