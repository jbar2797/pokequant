import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for factor_returns listing and portfolio attribution logic (uses admin test-insert helper)

describe('Factor returns & Portfolio attribution', () => {
  it('lists manually inserted factor return row', async () => {
    // Insert a synthetic factor return row
    const ins = await SELF.fetch('https://example.com/admin/test-insert', {
      method: 'POST',
      headers: { 'x-admin-token':'test-admin', 'content-type':'application/json' },
      body: JSON.stringify({ table: 'factor_returns', rows: [ { as_of: '2025-08-28', factor: 'ts7', ret: 0.1234 } ] })
    });
    expect(ins.status).toBe(200);
    const list = await SELF.fetch('https://example.com/admin/factor-returns', { headers: { 'x-admin-token':'test-admin' }});
    expect(list.status).toBe(200);
  const j = await list.json() as any;
  const row = (j.rows||[]).find((r:any)=> r.as_of==='2025-08-28' && r.factor==='ts7');
    expect(row).toBeTruthy();
    expect(Math.abs(row.ret - 0.1234)).toBeLessThan(1e-9);
  });

  it('computes portfolio attribution using synthetic exposures & factor returns', async () => {
    // Create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method: 'POST' });
    expect(create.status).toBe(200);
  const pj = await create.json() as any;
    const pid = pj.id; const sec = pj.secret;
    expect(pid).toBeTruthy(); expect(sec).toBeTruthy();
    // Seed nav, exposure, factor return for day 2025-08-28 -> 2025-08-29 (return 5%)
    const body = {
      table: 'portfolio_nav',
      rows: [
        { portfolio_id: pid, as_of: '2025-08-28', market_value: 100 },
        { portfolio_id: pid, as_of: '2025-08-29', market_value: 105 }
      ]
    };
    const navIns = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify(body)});
    expect(navIns.status).toBe(200);
    const expIns = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'portfolio_factor_exposure', rows:[ { portfolio_id: pid, as_of:'2025-08-28', factor:'ts7', exposure:1 } ] })});
    expect(expIns.status).toBe(200);
    const frIns = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'factor_returns', rows:[ { as_of:'2025-08-28', factor:'ts7', ret:0.05 } ] })});
    expect(frIns.status).toBe(200);
    const attrib = await SELF.fetch('https://example.com/portfolio/attribution?days=10', { headers:{ 'x-portfolio-id': pid, 'x-portfolio-secret': sec }});
    expect(attrib.status).toBe(200);
  const aj = await attrib.json() as any;
    expect(aj.ok).toBe(true);
    expect(Array.isArray(aj.rows)).toBe(true);
    const row = aj.rows.find((r:any)=> r.as_of==='2025-08-28');
    expect(row).toBeTruthy();
    // portfolio return should be 0.05, residual near zero, contribution ~0.05
    expect(Math.abs(row.portfolio_return - 0.05)).toBeLessThan(1e-9);
    expect(Math.abs(row.contributions.ts7 - 0.05)).toBeLessThan(1e-9);
    expect(Math.abs(row.residual)).toBeLessThan(1e-9);
  });
});
