import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const ADMIN='test-admin';

describe('Latency bucket metrics', () => {
  it('returns buckets object with tags (maybe empty)', async () => {
    // generate a few requests
    for (let i=0;i<3;i++) {
      await SELF.fetch('https://example.com/api/sets');
      await SELF.fetch('https://example.com/api/rarities');
    }
    const r = await SELF.fetch('https://example.com/admin/latency-buckets', { headers: { 'x-admin-token': ADMIN }});
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(j).toHaveProperty('buckets');
    expect(typeof j.buckets).toBe('object');
  });
});
