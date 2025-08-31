import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies nonce persistence and presence of signature headers path (simulation only; real fetch disabled)

describe('Webhook signing + nonce', () => {
  it('stores nonce for a simulated webhook delivery', async () => {
    // Create webhook endpoint (no failure params so first attempt success)
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook' }) });
    expect(create.status).toBe(200);
    // Seed card & price and alert
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_SIG', name:'CardSIG', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_SIG', as_of: today, price_usd:1, price_eur:1 }] }) });
    const alertRes = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'sig@test.com', card_id:'card_SIG', threshold:5 }) });
    expect(alertRes.status).toBe(200);
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    const deliveries = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await deliveries.json();
    expect(body.ok).toBe(true);
    const row = body.rows.find((r:any)=> r.webhook_id && r.nonce);
    expect(row).toBeTruthy();
    expect(typeof row.nonce).toBe('string');
    expect(row.nonce.length).toBeGreaterThan(10);
  });
});
