import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Backtest & Factor IC endpoints

describe('Backtest & Factor IC', () => {
  it('runs factor ic and backtest', async () => {
    const icRun = await SELF.fetch('https://example.com/admin/factor-ic/run', { method: 'POST', headers: { 'x-admin-token':'test-admin' }});
    expect(icRun.status).toBe(200);
    const icList = await SELF.fetch('https://example.com/admin/factor-ic', { headers: { 'x-admin-token':'test-admin' }});
    expect(icList.status).toBe(200);
    const back = await SELF.fetch('https://example.com/admin/backtests', { method: 'POST', headers: { 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ lookbackDays: 30 }) });
    expect(back.status).toBe(200);
    const list = await SELF.fetch('https://example.com/admin/backtests', { headers: { 'x-admin-token':'test-admin' }});
    expect(list.status).toBe(200);
    const snap = await SELF.fetch('https://example.com/admin/snapshot', { headers: { 'x-admin-token':'test-admin' }});
    expect(snap.status).toBe(200);
  }, 15000);
});
