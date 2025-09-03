import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// Basic idempotency behavior for portfolio add-lot & order creation.
// Uses a seeded portfolio created via /portfolio/create; replays add-lot and conflicts on mismatch.

async function createPortfolio(){
  const r = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
  expect(r.status).toBe(200);
  return await r.json() as any;
}

describe('Portfolio idempotency', () => {
  it('replays add-lot identical and conflicts on body mismatch', async () => {
    const { id, secret } = await createPortfolio();
    const key = 'idem-portfolio-lot-1';
    const body = { card_id:'CARD-1', qty: 2, cost_usd: 5 };
    const headers: Record<string,string> = { 'content-type':'application/json', 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'idempotency-key': key };
    const r1 = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers, body: JSON.stringify(body) });
    expect(r1.status).toBe(200);
    const j1:any = await r1.json();
    expect(j1.lot_id).toBeTruthy();
    const r2 = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers, body: JSON.stringify(body) });
    expect(r2.status).toBe(200);
    const j2:any = await r2.json();
    expect(j2.lot_id).toBe(j1.lot_id);
    // Mismatch (qty changed) should 409
    const bad = { ...body, qty: 3 };
    const r3 = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers, body: JSON.stringify(bad) });
    expect(r3.status).toBe(409);
  });
});
