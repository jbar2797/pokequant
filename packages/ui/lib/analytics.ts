export interface SeriesPoint { t: number; price: number; score?: number }

function safeNumbers(points: SeriesPoint[]): number[] {
  return points
    .filter(p => typeof p.price === 'number' && !Number.isNaN(p.price))
    .sort((a,b)=> a.t - b.t)
    .map(p => p.price);
}

export function computeVolatility(points: SeriesPoint[]): number | null {
  const prices = safeNumbers(points);
  if (prices.length < 3) return null;
  const rets: number[] = [];
  for (let i=1;i<prices.length;i++) {
    const prev = prices[i-1];
    const cur = prices[i];
    if (prev > 0) rets.push(cur/prev - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const variance = rets.reduce((a,b)=> a + (b-mean)**2, 0)/(rets.length-1);
  const dailyVol = Math.sqrt(variance);
  const annualized = dailyVol * Math.sqrt(365);
  return annualized * 100; // percent
}

export function computeMaxDrawdown(points: SeriesPoint[]): number | null {
  const prices = safeNumbers(points);
  if (prices.length < 2) return null;
  let peak = prices[0];
  let maxDd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = peak > 0 ? (peak - p)/peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100; // percent
}

export function computeLiquidity(points: SeriesPoint[]): number | null {
  const prices = safeNumbers(points);
  if (prices.length < 5) return null;
  let sumAbs = 0;
  let count = 0;
  for (let i=1;i<prices.length;i++) {
    const prev = prices[i-1];
    const cur = prices[i];
    if (prev > 0) { sumAbs += Math.abs(cur/prev - 1); count++; }
  }
  if (!count) return null;
  const avgAbsRet = sumAbs / count; // daily
  // Convert to a simple liquidity index (higher average movement -> lower liquidity). Invert & scale.
  const liq = 1 / (avgAbsRet * 100 + 0.01); // arbitrary scaling
  return liq;
}

export function formatNumber(val: number | null, opts: Intl.NumberFormatOptions = {}): string {
  if (val == null || Number.isNaN(val)) return '–';
  return new Intl.NumberFormat('en-US', opts).format(val);
}
