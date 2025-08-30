import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for new /admin/factor-performance and enhanced /admin/factor-ic/summary

describe('Factor performance & IC summary', () => {
  it('returns rolling IC summary with expected window fields', async () => {
    // Seed some factor_ic rows across days
    const rows = [] as any[];
    for (let i=10; i>=0; i--) {
      const d = new Date(Date.now() - i*86400000).toISOString().slice(0,10);
      rows.push({ as_of: d, factor: 'ts7', ic: (i%2===0? 0.05 : -0.02) });
    }
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_ic', rows }) });
    expect(ins.status).toBe(200);
    const res = await SELF.fetch('https://example.com/admin/factor-ic/summary', { headers:{'x-admin-token':'test-admin'} });
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
    const row = (j.rows||[]).find((r:any)=> r.factor==='ts7');
    expect(row).toBeTruthy();
    // Check presence of new windowed stats
    for (const k of ['avg_ic','avg_abs_ic','hit_rate','ir','avg_ic_30','avg_abs_ic_30','hit_rate_30','ir_30','avg_ic_7','avg_abs_ic_7','hit_rate_7','ir_7']) {
      expect(k in row).toBe(true);
    }
  });

  it('returns factor performance with suggested weights normalized', async () => {
    // Seed returns & ic for two factors
    const today = new Date().toISOString().slice(0,10);
    const rowsRet = [
      { as_of: today, factor: 'ts7', ret: 0.01 },
      { as_of: today, factor: 'ts30', ret: -0.005 }
    ];
    const rowsIc = [
      { as_of: today, factor: 'ts7', ic: 0.10 },
      { as_of: today, factor: 'ts30', ic: 0.05 }
    ];
    const ins1 = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_returns', rows: rowsRet }) });
    expect(ins1.status).toBe(200);
    const ins2 = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_ic', rows: rowsIc }) });
    expect(ins2.status).toBe(200);
    const perf = await SELF.fetch('https://example.com/admin/factor-performance', { headers:{'x-admin-token':'test-admin'} });
    expect(perf.status).toBe(200);
    const pj = await perf.json() as any;
    expect(pj.ok).toBe(true);
    expect(Array.isArray(pj.factors)).toBe(true);
    const sum = (pj.factors||[]).reduce((s:number,x:any)=> s + (x.weight_suggest||0),0);
    // Sum of normalized weights should be ~1
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  });
});
