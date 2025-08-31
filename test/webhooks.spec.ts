import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests webhook endpoint creation and simulated delivery on alert fire.

describe('Webhooks', () => {
  it('creates webhook and logs delivery for fired alert', async () => {
    // Create webhook
    const whRes = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook' }) });
    expect(whRes.status).toBe(200);
    const wh = await whRes.json() as any;
    expect(wh.ok).toBe(true);

    // Seed card & price for alert
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_WH', name:'CardWH', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_WH', as_of: today, price_usd:5, price_eur:5 }] }) });
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'wh@test', card_id:'card_WH', threshold:10 }) });
    expect(create.status).toBe(200);

    // Run alerts to trigger webhook delivery
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });

    // List webhook deliveries
    const del = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    expect(del.status).toBe(200);
    const body:any = await del.json();
    expect(body.ok).toBe(true);
    const rows = body.rows as any[];
    expect(rows.find(r=> r.event==='alert.fired')).toBeTruthy();
  });
});
