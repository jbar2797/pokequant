import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Signal quality metrics', () => {
  it('returns metrics with expected fields', async () => {
    // Seed factor_ic history for one factor so metrics computation could exist
    const rows:any[] = [];
    for (let i=15;i>=0;i--) {
      const d = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
      rows.push({ as_of: d, factor: 'ts7', ic: (i%3===0? 0.08 : -0.04) });
    }
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_ic', rows }) });
    expect(ins.status).toBe(200);
    const mq = await SELF.fetch('https://example.com/admin/signal-quality', { headers:{'x-admin-token':'test-admin'} });
    expect(mq.status).toBe(200);
    const mj = await mq.json() as any;
    expect(mj.ok).toBe(true);
    if ((mj.metrics||[]).length) {
      const m = mj.metrics[0];
      for (const k of ['factor','ic_mean','ic_vol','ic_autocorr_lag1','ic_half_life']) expect(k in m).toBe(true);
    }
  });
});
