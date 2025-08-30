import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio PnL endpoint', () => {
  it('returns portfolio pnl rows when present', async () => {
    // Seed portfolio_nav snapshots to allow pnl compute to have data (simulate nav snapshots)
    const today = new Date();
    const rows:any[] = [];
    for (let i=3;i>=0;i--) {
      const d = new Date(today.getTime()-i*86400000).toISOString().slice(0,10);
      rows.push({ as_of: d, portfolio_id: 'P1', market_value: 100 + (3-i)*5 });
    }
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'portfolio_nav', rows }) });
    expect(ins.status).toBe(200);
    const pnl = await SELF.fetch('https://example.com/admin/portfolio-pnl', { headers:{'x-admin-token':'test-admin'} });
    expect(pnl.status).toBe(200);
    const pj = await pnl.json() as any;
    expect(pj.ok).toBe(true);
    expect(Array.isArray(pj.rows)).toBe(true);
  });
});
