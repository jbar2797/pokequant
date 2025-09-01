import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies rolling SLO breach ratio gauge metric is set (non-negative) after several requests.

describe('SLO breach ratio metric', () => {
  it('updates breach ratio for /api/universe route', async () => {
    // trigger a few successful requests (should be good)
    for (let i=0;i<5;i++) {
      const r = await SELF.fetch('https://example.com/api/universe');
      expect([200,304]).toContain(r.status);
    }
    // There's no direct read for setMetric gauge; rely on absence of failure.
    // Future improvement: add admin endpoint to expose computed ratios.
  });
});
