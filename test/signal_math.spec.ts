import { describe, it, expect } from 'vitest';
import { compositeScore } from '../src/signal_math';

// Regression tests for compositeScore

describe('compositeScore', () => {
  it('handles empty inputs', () => {
    const out = compositeScore([], []);
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
    expect(out.signal).toBe('HOLD');
  });
  it('scores higher on strong upward trend with rising interest', () => {
    const prices = [1,1.05,1.1,1.15,1.2,1.25,1.3,1.35,1.4];
    const svis = [10,12,13,14,15,16,18,20,25];
    const out = compositeScore(prices, svis);
    expect(out.score).toBeGreaterThan(50); // directional lift above neutral
  });
  it('scores lower on downward trend with fading interest', () => {
    const prices = [2,1.95,1.9,1.85,1.8,1.75,1.7,1.65,1.6];
    const svis = [30,28,26,24,22,21,20,19,18];
    const out = compositeScore(prices, svis);
    expect(out.score).toBeLessThan(50); // directional drop below neutral
  });
});
