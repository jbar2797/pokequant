import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Admin latency endpoint', () => {
  it('returns ok with rows array', async () => {
    // generate at least one request to produce latency metrics
    await SELF.fetch('https://example.com/api/sets');
    const r = await SELF.fetch('https://example.com/admin/latency', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
  });
});
