import { describe, it, expect } from 'vitest';
import { beforeCall, afterCall } from '../src/lib/circuit_breaker';

// Unit-level exercise of circuit breaker open -> half-open -> close path.

describe('circuit_breaker', () => {
  it('opens after failure ratio exceeded then blocks', async () => {
    const key = 'unit:test';
    // cause failures; default minSamples=5 failRatio=0.5 so need >=3 fails of 5
    afterCall(key, false); // 1/1
    afterCall(key, false); // 2/2
    afterCall(key, false); // 3/3 -> ratio 1, should open because total>=5 not yet; keep going
    afterCall(key, true);  // 3/4
    afterCall(key, false); // 4/5 -> fails 4/5=0.8 => open
    const g1 = beforeCall(key);
    expect(g1.allow).toBe(false); // open state blocks
  });

  it('half-open transitions back to closed after success', async () => {
    const key = 'unit:test2';
    // Open it
    afterCall(key, false); afterCall(key,false); afterCall(key,false); afterCall(key,true); afterCall(key,false); // open
    const blocked = beforeCall(key); expect(blocked.allow).toBe(false);
    // Monkey patch Date.now to simulate passage beyond openMs (30s)
    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start + 31_000; // > openMs
      const probe = beforeCall(key); // should be half-open allow
      expect(probe.allow).toBe(true);
      // Successful call closes breaker
      afterCall(key, true);
      const post = beforeCall(key);
      expect(post.allow).toBe(true); // closed again
    } finally { Date.now = realNow; }
  });
});
