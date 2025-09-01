import { describe, it, expect } from 'vitest';
import { mean, variance, covariance, pearson, rankIC, lag1Autocorr, halfLifeFromPhi, bayesianShrink } from '../src/lib/factor_math';

describe('factor_math helpers', () => {
  it('mean/variance basics', () => {
    expect(mean([1,2,3])).toBe(2);
    expect(variance([1,2,3])).toBeCloseTo(1, 6); // sample variance
  });
  it('covariance & pearson', () => {
    const a=[1,2,3,4], b=[2,4,6,8];
  // Sample covariance should equal sum((a-mean(a))*(b-mean(b)))/(n-1)
  const meanA = mean(a); const meanB = mean(b);
  const expectedCov = a.reduce((s,ai,i)=> s + (ai-meanA)*(b[i]-meanB), 0)/(a.length-1);
  expect(covariance(a,b)).toBeCloseTo(expectedCov, 6);
    expect(pearson(a,b)).toBeCloseTo(1, 6);
  });
  it('rankIC returns null for insufficient data', () => {
    expect(rankIC([1,2,3],[0.1,0.2,0.3])).toBeNull();
  });
  it('rankIC works for larger sample', () => {
    const vals = [1,5,2,4,3,9,7,8,6,10];
    const rets = vals.map(v=> v*0.01 + (v%2? 0.001: -0.001));
    const ic = rankIC(vals, rets);
    expect(ic).not.toBeNull();
    expect(ic!).toBeGreaterThan(0.8);
  });
  it('autocorr & half-life', () => {
    const series = [1,2,3,4,5,6];
    const ac = lag1Autocorr(series);
    expect(ac).not.toBeNull();
    const hl = halfLifeFromPhi(ac);
    expect(hl).not.toBeNull();
    expect(hl!).toBeGreaterThan(0);
  });
  it('bayesianShrink shrinks towards prior', () => {
    const sample = [10,11,9,10];
    const priorMean = 0; const priorVar = 1;
    const shrunk = bayesianShrink(sample, priorMean, priorVar);
    expect(shrunk).not.toBeNull();
    expect(shrunk!).toBeGreaterThan(5); // not fully shrunk to prior
  });
});
