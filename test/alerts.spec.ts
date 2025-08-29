import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Alert firing flow test (seed card + price, create alert below price, ensure not fired, then adjust price and run alerts)

const ADMIN='test-admin';

async function seed(price: number) {
  const body = { cards: [{ id:'cardA', name:'Alpha', price_usd: price }] };
  await SELF.fetch('https://example.com/admin/test-seed', { method:'POST', headers:{ 'x-admin-token': ADMIN }, body: JSON.stringify(body) });
}

describe('Alerts', () => {
  it('fires when price crosses below threshold', async () => {
    await seed(10);
    // Create alert price_below 9 (should not fire yet)
    const createResp = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({ email:'a@test', card_id:'cardA', kind:'price_below', threshold:9 }) });
    expect(createResp.status).toBe(200);
    const created = await createResp.json() as any;
    expect(created.ok).toBe(true);
    // Run alerts (should not fire)
    const initialRun = await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token': ADMIN } });
    const first = await initialRun.json() as any;
    expect(first.fired).toBe(0);
    // Price drops
    await seed(8);
    const secondRun = await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token': ADMIN } });
    const second = await secondRun.json() as any;
    expect(second.fired).toBe(1);
  });

  it('can deactivate an alert via GET link', async () => {
    // Seed card and price
    const adminHeaders = { 'x-admin-token': 'test-admin' };
    await SELF.fetch('https://example.com/admin/test-seed', { method:'POST', headers: adminHeaders, body: JSON.stringify({ cards:[{ id:'cardB', price_usd: 50 }] }) });
    // Create alert
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({ email:'b@test', card_id:'cardB', threshold: 40 }) });
    const cj:any = await create.json();
    expect(cj.ok).toBe(true);
    const deactivateUrl = cj.manage_url;
    expect(deactivateUrl).toContain('/alerts/deactivate');
    // Call GET deactivate
    const deact = await SELF.fetch(deactivateUrl, { method:'GET' });
    expect(deact.status).toBe(200);
    const html = await deact.text();
    expect(html.toLowerCase()).toContain('alert deactivated');
  });
});
