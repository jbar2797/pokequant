// src/signal_math.ts
// Robust time-series utilities for Workers (no external deps).

export type Series = number[];

// --- Basic helpers ---

export function logify(xs: Series): Series {
  const out: number[] = [];
  for (const x of xs) if (typeof x === 'number' && x > 0) out.push(Math.log(x));
  return out;
}
export function returnsFromLogs(ys: Series): Series {
  const r: number[] = [];
  for (let i = 1; i < ys.length; i++) r.push(ys[i] - ys[i-1]);
  return r;
}
export function median(xs: Series): number {
  const s = xs.slice().sort((a,b)=>a-b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n-1)/2] : 0.5*(s[n/2 - 1] + s[n/2]);
}
export function mad(xs: Series, m?: number): number {
  const med = (m===undefined) ? median(xs) : m;
  return median(xs.map(x => Math.abs(x - med))) || 1e-9;
}
export function robustZ(x: number, xs: Series): number {
  const m = median(xs);
  const s = 1.4826 * mad(xs, m); // MAD -> sigma
  return (x - m) / (s || 1e-9);
}

// Robust Theil–Sen slope estimator (subsampled for speed)
export function theilSenSlope(y: Series): number {
  const n = y.length;
  if (n < 3) return 0;
  const step = Math.max(1, Math.floor(n / 60)); // limit O(n^2)
  const pairs: number[] = [];
  for (let i = 0; i < n; i += step) {
    for (let j = i+1; j < n; j += step) {
      const s = (y[j] - y[i]) / (j - i);
      if (Number.isFinite(s)) pairs.push(s);
    }
  }
  return median(pairs);
}

// --- Huberized Local Linear Trend (Kalman) with exogenous SVI ---
// y_t = l_t + phi * svi_t + e_t,  e_t ~ N(0,R)
// l_t = l_{t-1} + b_{t-1} + eta_t,   b_t = b_{t-1} + zeta_t
export function kalmanLLTWithSVI_series(
  y: Series, svi: Series, params?: { R?: number, Ql?: number, Qb?: number, phi?: number, huberDelta?: number }
) {
  const n = Math.min(y.length, svi.length);
  if (n < 5) return { levels: [], slopes: [], expRet: 0, expSd: 1 };

  const R  = params?.R  ?? 0.02;   // measurement variance on log-price
  const Ql = params?.Ql ?? 1e-4;   // level drift variance
  const Qb = params?.Qb ?? 1e-5;   // slope drift variance
  const phi= params?.phi?? 0.002;  // weight on SVI
  const delta = params?.huberDelta ?? 2.5;

  // State x=[l,b], Cov P(2x2)
  let l = y[0], b = 0;
  let P11 = 1, P12 = 0, P22 = 1;

  const levels: number[] = [];
  const slopes: number[] = [];

  for (let t = 0; t < n; t++) {
    // Predict
    const l_pred = l + b;
    const b_pred = b;

    // Cov predict
    const P11p = P11 + 2*P12 + P22 + Ql;
    const P12p = P12 + P22;
    const P22p = P22 + Qb;

    // Observation prediction with exogenous svi
    const yhat = l_pred + phi * svi[t];

    // Innovation + robust (Huber) weighting
    let v = y[t] - yhat;
    let S = P11p + R;
    const std = Math.sqrt(S || 1e-9);
    const r = v / (std || 1e-9);

    // Downweight outliers
    if (Math.abs(r) > delta) {
      const w = delta / Math.abs(r);
      S = S / w; // inflate innovation variance
    }

    // Kalman gain (H=[1,0])
    const K1 = P11p / (S || 1e-9);
    const K2 = P12p / (S || 1e-9);

    // Update
    l = l_pred + K1 * v;
    b = b_pred + K2 * v;

    // Cov update
    const nP11 = (1 - K1) * P11p;
    const nP12 = (1 - K1) * P12p;
    const nP22 = P22p - K2 * P12p;
    P11 = nP11; P12 = nP12; P22 = nP22;

    levels.push(l);
    slopes.push(b);
  }

  // One-step-ahead forecast relative to last observation
  const l_predN = l + b;
  const yhatN = l_predN + (params?.phi ?? 0.002) * svi[n-1];
  const expRet = yhatN - y[n-1];
  const expSd  = Math.sqrt(P11 + R);

  return { levels, slopes, expRet, expSd };
}

// Classic CUSUM to flag a regime change in slope
export function cusumChange(xs: Series, k = 0.0, h = 5.0) {
  let gp = 0, gn = 0, changed = false;
  for (const x of xs) {
    gp = Math.max(0, gp + x - k);
    gn = Math.max(0, gn - x - k);
    if (gp > h || gn > h) { changed = true; gp = 0; gn = 0; }
  }
  return changed;
}

export function compositeScore(prices: Series, svi: Series) {
  const y = logify(prices);
  const n = Math.min(y.length, Math.max(y.length, svi.length || 0));
  const yN = y.slice(-Math.min(y.length, 150)); // last ~150 days max

  // --- Handle SVI gracefully ---
  let sviN: number[];
  let sviUsed = true;
  if (!Array.isArray(svi) || svi.length < 7) {
    sviUsed = false;
    sviN = new Array(yN.length).fill(0); // exogenous regressor off
  } else {
    sviN = svi.slice(-(yN.length));
  }

  if (yN.length < 7) {
    return {
      score: 50, signal: 'HOLD',
      reasons: ['insufficient price history'],
      edgeZ: 0, expRet: 0, expSd: 1,
      components: { ts7: 0, ts30: 0, dd: 0, vol: 0, zSVI: 0, regimeBreak: false, sviUsed: false }
    };
  }

  // State-space (robust) + exogenous SVI (phi=0 when sviUsed=false)
  const { levels, slopes, expRet, expSd } =
    kalmanLLTWithSVI_series(yN, sviN, { phi: sviUsed ? 0.002 : 0 });

  const edgeZ = expRet / (expSd || 1e-9);

  // Demand shock: z-score of weekly SVI change (0 if not used)
  let zSVI = 0;
  if (sviUsed) {
    const sviDiff = sviN.map((v,i,arr)=> i? v - arr[i-1] : 0).slice(1);
    zSVI = robustZ((sviN[sviN.length-1] - (sviN[sviN.length-8] ?? sviN[sviN.length-1])), sviDiff);
  }

  // Robust trends
  const ts7  = theilSenSlope(yN.slice(-7));
  const ts30 = theilSenSlope(yN.slice(-30));

  // Value proxy: drawdown from 90-day peak (in log space)
  const y90 = yN.slice(-90);
  const peak = Math.max(...y90);
  const last = yN[yN.length-1];
  const dd = (peak - last) / (Math.abs(peak) > 0 ? Math.abs(peak) : 1e-9); // 0..1

  // Noise penalty: median abs deviation of daily returns
  const vol = mad(returnsFromLogs(yN));

  // Regime: look at last ~20 slopes for change
  const changed = cusumChange(slopes.slice(-20), 0, 3.0);

  // Blend into a logistic score; weights are tunable
  const linear = 1.2*edgeZ + 0.6*zSVI + 0.4*(ts7 + ts30) + 0.3*(1 - Math.min(dd,1)) - 0.3*(vol*10) - (changed?0.5:0);
  const score  = 100 / (1 + Math.exp(-linear)); // 0..100
  let signal   = score >= 70 ? 'BUY' : (score >= 40 ? 'HOLD' : 'SELL');
  if (changed) signal = 'HOLD'; // freeze on regime break

  const reasons = [
    `edgeZ=${edgeZ.toFixed(2)}`,
    `zSVI=${zSVI.toFixed(2)}`,
    `TS(7)=${ts7.toExponential(2)}`,
    `TS(30)=${ts30.toExponential(2)}`,
    `DD=${(dd*100).toFixed(1)}%`,
    `VOL≈${vol.toFixed(3)}`,
    changed ? 'regime_break' : 'stable',
    sviUsed ? 'svi=on' : 'svi=off'
  ];

  return {
    score, signal, reasons, edgeZ, expRet, expSd,
    components: { ts7, ts30, dd, vol, zSVI, regimeBreak: changed, sviUsed }
  };
}
