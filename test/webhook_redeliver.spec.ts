import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests manual webhook redelivery endpoint

describe('Webhook redelivery', () => {
  it('redelivers a prior payload', async () => {
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook?fail=1' }) });
    expect(create.status).toBe(200);
    // Seed alert prerequisites
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_RD', name:'CardRD', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_RD', as_of: today, price_usd:5, price_eur:5 }] }) });
    await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'rd@test.com', card_id:'card_RD', threshold:20 }) });
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    const deliveries = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const dBody: any = await deliveries.json();
    const first = dBody.rows.find((r:any)=> r.event==='alert.fired');
    expect(first).toBeTruthy();
    const redeliver = await SELF.fetch('https://example.com/admin/webhooks/redeliver', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ delivery_id:first.id }) });
    expect(redeliver.status).toBe(200);
    const redeliverBody: any = await redeliver.json();
    expect(redeliverBody.ok).toBe(true);
    const after = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const afterBody: any = await after.json();
    const redelivered = afterBody.rows.find((r:any)=> r.id===redeliverBody.id);
    expect(redelivered).toBeTruthy();
  });
});
