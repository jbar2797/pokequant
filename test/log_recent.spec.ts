import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Smoke test for recent logs ring buffer endpoint.

describe('Recent logs admin endpoint', () => {
  it('returns ok with logs array', async () => {
    // Trigger something that logs (metrics fetch sets context & SLO data may log)
    await SELF.fetch('https://example.com/health');
    const r = await SELF.fetch('https://example.com/admin/logs/recent', { headers:{ 'x-admin-token':'test-admin' } });
    expect(r.status).toBe(200);
    const body:any = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.logs)).toBe(true);
  });
});
