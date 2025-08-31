import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Ensures provider_message_id is persisted when RESEND_API_KEY='test'

describe('Email provider_message_id persistence', () => {
  it('stores provider_message_id on successful send', async () => {
    // Seed card & price
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_P', name:'CardP', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_P', as_of: today, price_usd:50, price_eur:50 }] }) });
    // Create alert that will fire (price below threshold)
    const res = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email:'idtest@example.com', card_id:'card_P', threshold:100 }) });
    expect(res.status).toBe(200);
    // Run alerts and process queue
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    await SELF.fetch('https://example.com/admin/alert-queue/send', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    // List deliveries
    const list = await SELF.fetch('https://example.com/admin/email/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    const body:any = await list.json();
    expect(body.ok).toBe(true);
    const row = (body.rows as any[]).find(r=> r.email==='idtest@example.com');
    expect(row).toBeTruthy();
    // provider_message_id should exist (non-empty string)
    expect(typeof row.provider_message_id === 'string').toBe(true);
    expect(row.provider_message_id.length).toBeGreaterThan(5);
  });
});
