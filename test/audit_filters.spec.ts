import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Audit filter coverage tests

describe('Audit log filters', () => {
  it('filters by actor_type and resource', async () => {
    // Create alert (public actor)
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email:'f@test.com', card_id:'CARDX', threshold:5, kind:'price_below' }) });
    expect(create.status).toBe(200);
    // Create portfolio + add lot (public/portfolio actor)
    const portResp = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(portResp.status).toBe(200);
    const pj:any = await portResp.json();
    const addLot = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{'content-type':'application/json','x-portfolio-id':pj.id,'x-portfolio-secret':pj.secret}, body: JSON.stringify({ card_id:'CARDX', qty:1, cost_usd:10 }) });
    expect(addLot.status).toBe(200);
    // Run audit list filtered by actor_type=portfolio
    const listPortfolio = await SELF.fetch('https://example.com/admin/audit?actor_type=portfolio&limit=50', { headers:{'x-admin-token':'test-admin'} });
    expect(listPortfolio.status).toBe(200);
    const lp:any = await listPortfolio.json();
    expect(lp.ok).toBe(true);
    expect((lp.rows||[]).some((r:any)=> r.actor_type==='portfolio' && r.action==='add_lot')).toBe(true);
    // Filter by resource=alert
    const listAlert = await SELF.fetch('https://example.com/admin/audit?resource=alert&limit=50', { headers:{'x-admin-token':'test-admin'} });
    expect(listAlert.status).toBe(200);
    const la:any = await listAlert.json();
    expect(la.ok).toBe(true);
    expect((la.rows||[]).some((r:any)=> r.resource==='alert' && r.action==='create')).toBe(true);
  });
});
