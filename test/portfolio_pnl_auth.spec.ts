import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Authenticated portfolio /portfolio/pnl endpoint test

describe('Portfolio PnL auth', () => {
  it('requires auth and returns ok with empty rows when seeded', async () => {
    // Create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(create.status).toBe(200);
    const pj = await create.json() as any;
    const pid = pj.id; const sec = pj.secret;
    // Seed some nav snapshots via admin test-insert (simulate daily market values)
    const today = new Date();
    const rows:any[] = [];
    for (let i=4;i>=0;i--) {
      const d = new Date(today.getTime()-i*86400000).toISOString().slice(0,10);
      rows.push({ portfolio_id: pid, as_of: d, market_value: 100 + (4-i)*3 });
    }
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'portfolio_nav', rows }) });
    expect(ins.status).toBe(200);
    const pnl = await SELF.fetch('https://example.com/portfolio/pnl', { headers:{ 'x-portfolio-id': pid, 'x-portfolio-secret': sec } });
    expect(pnl.status).toBe(200);
    const j = await pnl.json() as any;
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
  });
});
