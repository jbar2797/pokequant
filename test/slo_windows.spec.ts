import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// SLO rolling windows debug endpoint tests
// Ensures forbidden without token and returns expected shape with samples/breach_ratio keys

describe('SLO windows debug', () => {
  it('requires admin token', async () => {
    const r = await SELF.fetch('https://example.com/admin/slo/windows');
    expect(r.status).toBe(403);
    const j = await r.json() as any;
    expect(j.error).toBe('forbidden');
  });
  it('returns windows object (may be empty immediately after traffic)', async () => {
    // Generate traffic on multiple routes to increase chance windows populated
    for (let i=0;i<8;i++) {
      await SELF.fetch('https://example.com/api/universe');
      await SELF.fetch('https://example.com/api/cards');
    }
    const r = await SELF.fetch('https://example.com/admin/slo/windows', { headers:{ 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    const winObj = j.windows;
    expect(winObj && typeof winObj === 'object').toBe(true);
    const entries = Object.entries(winObj);
    // Windows can legitimately be empty if classification hasn't flushed yet; ensure shape when present
    for (const [slug, rec] of entries) {
      expect(typeof (rec as any).samples).toBe('number');
      expect((rec as any).samples).toBeGreaterThanOrEqual(0);
      expect(typeof (rec as any).breach_ratio).toBe('number');
      expect((rec as any).breach_ratio).toBeGreaterThanOrEqual(0);
      expect((rec as any).breach_ratio).toBeLessThanOrEqual(1);
    }
  });
});
