import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies email deliveries table logging for success + simulated failure

describe('Email deliveries logging', () => {
  it('logs success and failure attempts', async () => {
    // Create two alerts (one will succeed, one will simulate failure by email containing fail)
    // Seed card & price (price 50, thresholds 100 so price_below triggers)
    const today = new Date().toISOString().slice(0,10);
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'card_X', name:'CardX', set_name:'Set', rarity:'Rare' }] }) });
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'prices_daily', rows:[{ card_id:'card_X', as_of: today, price_usd:50, price_eur:50 }] }) });
    for (const email of ['ok1@test.dev','fail1@test.dev']) {
      const res = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ email, card_id:'card_X', threshold:100 }) });
      expect(res.status).toBe(200);
    }
    // Run alerts to enqueue
    await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    // Process queue
    await SELF.fetch('https://example.com/admin/alert-queue/send', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    // List email deliveries
    const list = await SELF.fetch('https://example.com/admin/email/deliveries', { headers:{ 'x-admin-token':'test-admin' } });
    expect(list.status).toBe(200);
    const body:any = await list.json();
    expect(body.ok).toBe(true);
    // Should have at least 2 rows (one for each attempt)
    const rows = body.rows as any[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const success = rows.find(r=> r.email==='ok1@test.dev');
    const failure = rows.find(r=> r.email==='fail1@test.dev');
    expect(success).toBeTruthy();
    expect(failure).toBeTruthy();
  });
});
