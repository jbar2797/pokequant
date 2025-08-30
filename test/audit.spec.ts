import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Basic audit logging smoke test

describe('Audit log', () => {
  it('records alert create/deactivate and lists them', async () => {
    // Create alert
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email:'a@test.com', card_id:'CARD1', threshold:10, kind:'price_below' }) });
    expect(create.status).toBe(200);
    const cj:any = await create.json();
    expect(cj.ok).toBe(true);
    // Deactivate via POST
    const deactivate = await SELF.fetch('https://example.com/alerts/deactivate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: cj.id, token: cj.manage_token }) });
    expect(deactivate.status).toBe(200);
    const dj:any = await deactivate.json();
    expect(dj.ok).toBe(true);
    // List audit
    const list = await SELF.fetch('https://example.com/admin/audit', { headers:{'x-admin-token':'test-admin'} });
    expect(list.status).toBe(200);
    const lj:any = await list.json();
    expect(lj.ok).toBe(true);
    const actions = (lj.rows||[]).map((r:any)=> r.action);
    expect(actions).toContain('create');
    expect(actions).toContain('deactivate');
  });
});
