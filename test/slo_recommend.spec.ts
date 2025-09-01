import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('SLO recommend endpoint', () => {
  it('returns ok with rows array', async () => {
    const r = await SELF.fetch('https://example.com/admin/slo/recommend', { headers:{ 'x-admin-token':'test-admin' } });
    // In fast test mode may be empty but should still return ok
    expect(r.status).toBe(200);
    const j:any = await r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
  });
});
