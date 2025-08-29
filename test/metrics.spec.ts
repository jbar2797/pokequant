import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Metrics endpoint smoke test

describe('Admin metrics', () => {
  it('returns metrics rows (empty ok)', async () => {
    const r = await SELF.fetch('https://example.com/admin/metrics', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
  const j = await r.json() as any;
  expect(j.ok).toBe(true);
  expect(Array.isArray(j.rows)).toBe(true);
  });
});
