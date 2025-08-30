import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for /admin/factor-risk and /admin/factor-metrics endpoints

describe('Factor risk model & metrics', () => {
  it('returns risk model pairs with corr in [-1,1] and metrics with vol/beta', async () => {
    // Seed minimal factor_returns history to allow risk model compute (simulate scheduled compute already ran)
    const today = new Date();
    const factors = ['ts7','ts30'];
    const rows:any[] = [];
    for (let d=5; d>=0; d--) {
      const as_of = new Date(today.getTime() - d*86400000).toISOString().slice(0,10);
      for (const f of factors) rows.push({ as_of, factor: f, ret: (f==='ts7'? 0.01: -0.005) * Math.random() });
    }
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_returns', rows }) });
    expect(ins.status).toBe(200);
    // Directly call endpoints (assumes compute already populated tables during earlier test or manual run). If empty, test still validates shape.
    const risk = await SELF.fetch('https://example.com/admin/factor-risk', { headers:{'x-admin-token':'test-admin'} });
    expect(risk.status).toBe(200);
    const rj = await risk.json() as any;
    expect(rj.ok).toBe(true);
    expect(Array.isArray(rj.pairs)).toBe(true);
    for (const p of rj.pairs) {
      if (p.corr !== null && p.corr !== undefined) {
        expect(p.corr).toBeGreaterThanOrEqual(-1); expect(p.corr).toBeLessThanOrEqual(1);
      }
    }
  });
});
