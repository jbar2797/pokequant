import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Simple rate limit test: exhaust small subscribe limit (5 per day) quickly
// We only send 5 requests to ensure they succeed (should not trip limit). A 6th would 429.

describe('Rate limiting', () => {
  it('allows initial subscribe requests within limit', async () => {
    for (let i=0;i<5;i++) {
      const r = await SELF.fetch('https://example.com/api/subscribe', { method:'POST', body: JSON.stringify({ email: `u${i}@x.test` }), headers: { 'content-type':'application/json' } });
      expect(r.status).toBe(200);
    }
  });
});
