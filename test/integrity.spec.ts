import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Integrity endpoint test

describe('Admin integrity', () => {
  it('returns snapshot with expected shape', async () => {
    const r = await SELF.fetch('https://example.com/admin/integrity', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(typeof j.total_cards).toBe('number');
    expect(j.latest && typeof j.latest === 'object').toBe(true);
    expect(j.coverage_latest && typeof j.coverage_latest === 'object').toBe(true);
    expect(j.gaps_last_30 && typeof j.gaps_last_30 === 'object').toBe(true);
    expect(Array.isArray(j.stale)).toBe(true);
  });
});
