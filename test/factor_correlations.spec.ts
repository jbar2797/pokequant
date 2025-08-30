import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Factor correlations smoke test

describe('Factor correlations', () => {
  it('returns matrix with factors when data present (may be sparse in pristine DB)', async () => {
    // Run fast to generate signals; then fabricate factor_returns rows via test insert if needed
    await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers:{'x-admin-token':'test-admin'} });
    // Insert synthetic factor_returns if absent (3 factors * 10 days)
    const existing = await SELF.fetch('https://example.com/admin/factor-returns', { headers:{'x-admin-token':'test-admin'} });
    const ej:any = await existing.json();
    if (!ej.rows || ej.rows.length < 10) {
      const today = new Date();
      const rows:any[] = [];
      const factors = ['ts7','ts30','z_svi'];
      for (let d=10; d>=1; d--) {
        const as_of = new Date(today.getTime() - d*86400000).toISOString().slice(0,10);
        for (const f of factors) {
          rows.push({ as_of, factor: f, ret: ((d%5)-2)/100 });
        }
      }
      await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_returns', rows }) });
    }
    const resp = await SELF.fetch('https://example.com/admin/factor-correlations?days=30', { headers:{'x-admin-token':'test-admin'} });
    expect(resp.status).toBe(200);
    const j:any = await resp.json();
    expect(j.ok).toBe(true);
    if (j.factors && j.factors.length >= 2) {
      expect(Array.isArray(j.matrix)).toBe(true);
    }
  });
});
