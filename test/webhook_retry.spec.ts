import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests webhook retry + metrics. Uses simulated failure via endpoint URL query params.

describe('Webhook retry logic', () => {
  it('retries until success when initial attempts fail', async () => {
    // Create webhook endpoint whose first 2 attempts fail then succeed
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook?fail=2' }) });
    expect(create.status).toBe(200);
    const createBody:any = await create.json();
    const webhookId = createBody.id;

    // Seed card + price to trigger alert
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_WH', name:'CardWH', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_WH', as_of: today, price_usd:10, price_eur:10 }] }) });
    // Create alert that will fire (price below threshold)
    const res = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'wh@test.com', card_id:'card_WH', threshold:50 }) });
    expect(res.status).toBe(200);
    // Run alerts (dispatch webhooks)
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });

    // Fetch deliveries
    const list = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await list.json();
    expect(body.ok).toBe(true);
  const rows = body.rows.filter((r:any)=> r.webhook_id===webhookId && r.event==='alert.fired');
    // Expect 3 attempts (2 failures then success)
    expect(rows.length).toBe(3);
    const attempts = rows.map((r:any)=> r.attempt).sort();
    expect(attempts).toEqual([1,2,3]);
    const okAttempts = rows.filter((r:any)=> r.ok===1);
    expect(okAttempts.length).toBe(1);
    expect(okAttempts[0].attempt).toBe(3);
  });

  it('records error metric when all attempts fail', async () => {
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook?always_fail=1' }) });
    expect(create.status).toBe(200);
    const createBody:any = await create.json();
    const webhookId = createBody.id;
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_WF', name:'CardWF', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_WF', as_of: today, price_usd:5, price_eur:5 }] }) });
    const res = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'wf@test.com', card_id:'card_WF', threshold:20 }) });
    expect(res.status).toBe(200);
  await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
  // Allow a microtask tick so any trailing async metric/delivery inserts complete.
  await new Promise(r=> setTimeout(r, 10));
    const list = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await list.json();
  const rows = body.rows.filter((r:any)=> r.webhook_id===webhookId && r.event==='alert.fired');
  expect(rows.length).toBe(3); // all failed attempts
    expect(rows.every((r:any)=> r.ok===0)).toBe(true);
  });
});
