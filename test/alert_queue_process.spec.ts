import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests alert queue processing endpoint updates status and increments alert.sent metric.

describe('Alert queue processing', () => {
  it('processes queued alerts and increments sent metric', async () => {
    // Seed price so alert will fire (price_below threshold above seed price or ensures condition)
    // Create synthetic card & price
    const cardId = 'ALERTCARD1';
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id: cardId, name:'Card', set_name:'Set', rarity:'Promo' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id: cardId, as_of: new Date().toISOString().slice(0,10), price_usd: 5, price_eur: 5 }] }) });

    // Create alert with threshold 10 (price_below fires)
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'u@test', card_id: cardId, threshold:10 }) });
    expect(create.status).toBe(200);

    // Run alerts to enqueue
    const run = await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    expect(run.status).toBe(200);
    const runData = await run.json() as any;
    expect(runData.fired).toBeGreaterThanOrEqual(1);

    const beforeMetrics = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    const before = await beforeMetrics.json() as any;
    const prevSent = (before.rows||[]).find((r:any)=> r.metric === 'alert.sent')?.count || 0;

    // Process queue
    const proc = await SELF.fetch('https://example.com/admin/alert-queue/send', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    expect(proc.status).toBe(200);
    const procData = await proc.json() as any;
    expect(procData.ok).toBe(true);
    expect(procData.processed).toBeGreaterThanOrEqual(1);

    const afterMetrics = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    const after = await afterMetrics.json() as any;
    const nextSent = (after.rows||[]).find((r:any)=> r.metric === 'alert.sent')?.count || 0;
    expect(nextSent).toBe(prevSent + procData.processed);
  });
});
