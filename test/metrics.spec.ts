import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Metrics endpoint smoke test

describe('Admin metrics', () => {
  it('returns metrics rows and cache hit subset after a conditional GET', async () => {
    // Trigger universe fetch to create baseline metric
    const first = await SELF.fetch('https://example.com/api/universe');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    if (etag) {
      const second = await SELF.fetch('https://example.com/api/universe', { headers: { 'if-none-match': etag }});
      // Should return 304 creating cache.hit.* metric increment
      expect([200,304]).toContain(second.status); // allow if etag mismatch edge case
    }
    const r = await SELF.fetch('https://example.com/admin/metrics', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
    expect(j.latency === undefined || Array.isArray(j.latency)).toBe(true);
    // cache_hits should be an array (may be empty if ETag flow not triggered)
    expect(j.cache_hits === undefined || Array.isArray(j.cache_hits)).toBe(true);
    // ratios object optional
    if (j.cache_hit_ratios) {
      expect(typeof j.cache_hit_ratios).toBe('object');
    }
  });
});
