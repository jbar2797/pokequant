import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const ADMIN='test-admin';

describe('Pipeline runs endpoint', () => {
  it('returns rows array (possibly empty)', async () => {
    const r = await SELF.fetch('https://example.com/admin/pipeline/runs', { headers: { 'x-admin-token': ADMIN }});
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
  });
});
