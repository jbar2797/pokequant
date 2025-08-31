import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests the /admin/webhooks/verify endpoint for nonce replay detection

describe('Webhook replay verification', () => {
  it('returns seen=true for existing nonce and false for random', async () => {
    // Create webhook endpoint
    const create = await SELF.fetch('https://example.com/admin/webhooks', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ url:'https://example.com/hook' }) });
    expect(create.status).toBe(200);
    // Seed card/price + alert to trigger webhook
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_REPLAY', name:'ReplayCard', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_REPLAY', as_of: today, price_usd:1, price_eur:1 }] }) });
    const alertRes = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'replay@test.com', card_id:'card_REPLAY', threshold:5 }) });
    expect(alertRes.status).toBe(200);
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    const deliveries = await SELF.fetch('https://example.com/admin/webhooks/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await deliveries.json();
    expect(body.ok).toBe(true);
    const row = body.rows.find((r:any)=> r.nonce);
    expect(row).toBeTruthy();
    const nonce = row.nonce;
    // Verify existing nonce
    const seenResp = await SELF.fetch(`https://example.com/admin/webhooks/verify?nonce=${nonce}`, { headers:{ 'x-admin-token':'test-admin' } });
    expect(seenResp.status).toBe(200);
    const seenJson:any = await seenResp.json();
    expect(seenJson.ok).toBe(true);
    expect(seenJson.seen).toBe(true);
    // Verify random nonce
    const rand = crypto.randomUUID();
    const randResp = await SELF.fetch(`https://example.com/admin/webhooks/verify?nonce=${rand}`, { headers:{ 'x-admin-token':'test-admin' } });
    const randJson:any = await randResp.json();
    expect(randJson.ok).toBe(true);
    expect(randJson.seen).toBe(false);
  });
});
