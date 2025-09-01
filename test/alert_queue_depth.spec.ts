import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies queue depth gauge metric updates after enqueue and send processing.

describe('Alert queue depth metrics', () => {
  it('records queue depth metric', async () => {
    const cardId = 'ALERTCARDDEPTH1';
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id: cardId, name:'Card', set_name:'Set', rarity:'Promo' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id: cardId, as_of: new Date().toISOString().slice(0,10), price_usd: 5 }] }) });

    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'u@test', card_id: cardId, threshold:10 }) });
    expect(create.status).toBe(200);

    const run = await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    expect(run.status).toBe(200);

    const metrics1 = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    const data1 = await metrics1.json() as any;
    const depth1 = (data1.rows||[]).find((r:any)=> r.metric === 'alert.queue.depth')?.count;
    expect(depth1).toBeGreaterThanOrEqual(1);

    const send = await SELF.fetch('https://example.com/admin/alert-queue/send', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    expect(send.status).toBe(200);

    const metrics2 = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    const data2 = await metrics2.json() as any;
    const depth2 = (data2.rows||[]).find((r:any)=> r.metric === 'alert.queue.depth')?.count;
    expect(depth2).toBeLessThanOrEqual(depth1);
  });
});
