import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Latency metrics', () => {
  it('surfaces latency summary after requests', async () => {
    // generate some traffic
    for (let i=0;i<5;i++) {
      await SELF.fetch('https://example.com/api/sets');
      await SELF.fetch('https://example.com/api/rarities');
    }
    const r = await SELF.fetch('https://example.com/admin/metrics', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.latency)).toBe(true);
    // at least one latency metric for sets or rarities
  const tags = new Set<string>(j.latency.map((l:any)=> String(l.base_metric||'')));
  expect(Array.from(tags).some((t:string)=> t.includes('sets') || t.includes('rarities'))).toBe(true);
  }, 30000);
});
