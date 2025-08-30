import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Backtest & Factor IC endpoints

describe('Backtest & Factor IC', () => {
  it('runs factor ic and backtest', async () => {
    // Warm signals (idempotent, may insert minimal seed rows)
    await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers:{'x-admin-token':'test-admin'} });
    // Run IC (may skip if insufficient data; still should return 200 quickly)
    const icRun = await SELF.fetch('https://example.com/admin/factor-ic/run', { method: 'POST', headers: { 'x-admin-token':'test-admin' }});
    expect(icRun.status).toBe(200);
    const icList = await SELF.fetch('https://example.com/admin/factor-ic', { headers: { 'x-admin-token':'test-admin' }});
    expect(icList.status).toBe(200);
    // Run a short lookback backtest to keep runtime small; retry once if no_data
    let back = await SELF.fetch('https://example.com/admin/backtests', { method: 'POST', headers: { 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ lookbackDays: 20, txCostBps:2 }) });
    if (back.status !== 200) throw new Error('backtest failed status');
    let bj: any = await back.json();
    if (!bj.ok) {
      await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers:{'x-admin-token':'test-admin'} });
      back = await SELF.fetch('https://example.com/admin/backtests', { method: 'POST', headers: { 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ lookbackDays: 10 }) });
      expect(back.status).toBe(200);
      bj = await back.json();
    }
    // list backtests (should not hang even if backtest returned ok:false)
    const list = await SELF.fetch('https://example.com/admin/backtests', { headers: { 'x-admin-token':'test-admin' }});
    expect(list.status).toBe(200);
    const snap = await SELF.fetch('https://example.com/admin/snapshot', { headers: { 'x-admin-token':'test-admin' }});
    expect(snap.status).toBe(200);
  }, 40000); // allow extra time in CI
});
