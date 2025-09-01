// Pure statistical helpers for factor analytics & signal quality.
// Isolated for unit testing to raise coverage and reduce cognitive load in factors.ts

export function mean(a: number[]): number { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }

export function variance(a: number[]): number { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s,x)=> s+(x-m)*(x-m),0)/(a.length-1); }

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0,n)); const mb = mean(b.slice(0,n));
  let sum = 0; for (let i=0;i<n;i++){ sum += (a[i]-ma)*(b[i]-mb); }
  return sum/(n-1);
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const cov = covariance(a.slice(0,n), b.slice(0,n));
  const va = variance(a.slice(0,n)); const vb = variance(b.slice(0,n));
  const den = Math.sqrt(va*vb)||0; return den? cov/den : 0;
}

// Spearman rank correlation (returns null if insufficient usable pairs <5)
export function rankIC(values: number[], rets: number[]): number|null {
  const n = Math.min(values.length, rets.length);
  const data: { v:number; r:number }[] = [];
  for (let i=0;i<n;i++) {
    const v = values[i]; const r = rets[i];
    if (Number.isFinite(v) && Number.isFinite(r)) data.push({ v, r });
  }
  if (data.length < 5) return null;
  const m = data.length;
  const idxV = data.map((_,i)=> i).sort((a,b)=> data[a].v - data[b].v);
  const idxR = data.map((_,i)=> i).sort((a,b)=> data[a].r - data[b].r);
  const rankV = new Array(m); const rankR = new Array(m);
  for (let i=0;i<m;i++){ rankV[idxV[i]] = i+1; rankR[idxR[i]] = i+1; }
  let sumV=0,sumR=0; for (let i=0;i<m;i++){ sumV+=rankV[i]; sumR+=rankR[i]; }
  const mv = sumV/m, mr = sumR/m; let num=0,dv=0,dr=0;
  for (let i=0;i<m;i++){ const a = rankV[i]-mv; const b = rankR[i]-mr; num+=a*b; dv+=a*a; dr+=b*b; }
  const den = Math.sqrt(dv*dr)||0; if (!den) return null; return num/den;
}

export function lag1Autocorr(series: number[]): number|null {
  if (series.length < 3) return null;
  const m = mean(series);
  let num=0,den=0;
  for (let i=1;i<series.length;i++){ num += (series[i]-m)*(series[i-1]-m); }
  for (const x of series) den += (x-m)*(x-m);
  if (!den) return null; return num/den;
}

export function halfLifeFromPhi(phi: number|null): number|null {
  if (phi===null) return null; if (phi <= 0) return null; const bounded = Math.min(0.999, Math.max(-0.999, phi)); return Math.log(0.5)/Math.log(bounded);
}

// Bayesian shrink helper replicating logic used in smoothing; returns shrunk mean.
export function bayesianShrink(sample: number[], priorMean: number, priorVar: number): number|null {
  const n = sample.length; if (!n) return null;
  const sampleMean = mean(sample);
  const sampleVar = variance(sample);
  const effectiveVar = (sampleVar>0? sampleVar : priorVar);
  const k = Math.max(1, Math.round(effectiveVar / (priorVar || 1e-6)));
  const weight = n / (n + k);
  return weight*sampleMean + (1-weight)*priorMean;
}
