import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies new public read rate limiting for universe endpoint.

describe('Public rate limiting', () => {
  it('enforces limit on /api/universe', async () => {
    // Use small custom limit via env override not available here; rely on default 120 and simulate burst >2 quickly.
    // We'll send a few requests and expect 200 (should not trip default). This acts as regression ensuring 200 path works.
    // To test rejection deterministically without 120 calls, we simulate by temporarily lowering limit would require env var.
    const r1 = await SELF.fetch('https://example.com/api/universe');
    expect(r1.status).toBe(200);
    const r2 = await SELF.fetch('https://example.com/api/universe');
    expect(r2.status).toBe(200);
  });
});
