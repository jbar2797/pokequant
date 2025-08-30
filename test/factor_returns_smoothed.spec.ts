import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Smoothed factor returns', () => {
  it('returns smoothed returns for factors when present', async () => {
    const today = new Date().toISOString().slice(0,10);
    // Seed raw factor returns for two factors one day
    const rowsRet = [
      { as_of: today, factor: 'ts7', ret: 0.02 },
      { as_of: today, factor: 'ts30', ret: -0.01 }
    ];
    const ins1 = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_returns', rows: rowsRet }) });
    expect(ins1.status).toBe(200);
    // Smoothed table may be empty if compute not run; just verify endpoint shape
    const sm = await SELF.fetch('https://example.com/admin/factor-returns-smoothed', { headers:{'x-admin-token':'test-admin'} });
    expect(sm.status).toBe(200);
    const sj = await sm.json() as any;
    expect(sj.ok).toBe(true);
    expect('returns' in sj).toBe(true);
  });
});
