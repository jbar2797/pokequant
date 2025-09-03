import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// Basic idempotency validation for /alerts/create

describe('Alerts create idempotency', () => {
  it('replays same response & conflicts on body mismatch', async () => {
    const key = 'idem-test-1';
    const body = { email:'idem@example.com', card_id:'CARD-1', kind:'price_below', threshold: 10 };
    // First request
    const r1 = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    expect(r1.status).toBe(200);
    const j1: any = await r1.json();
    expect(j1.ok).toBe(true);
    // Second identical
    const r2 = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    expect(r2.status).toBe(200);
    const j2: any = await r2.json();
    expect(j2.id).toBe(j1.id);
    // Mismatched body same key -> 409
    const bad = { ...body, threshold: 11 };
    const r3 = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{ 'content-type':'application/json', 'idempotency-key': key }, body: JSON.stringify(bad) });
    expect(r3.status).toBe(409);
  });
});
