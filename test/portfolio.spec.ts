import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Portfolio flow: create, add lots, verify totals

const ADMIN='test-admin';

async function seed(card_id: string, price: number) {
  await SELF.fetch('https://example.com/admin/test-seed', { method:'POST', headers:{ 'x-admin-token': ADMIN }, body: JSON.stringify({ cards:[{ id: card_id, name: card_id, price_usd: price }] }) });
}

describe('Portfolio', () => {
  it('computes market value and unrealized pnl', async () => {
    await seed('cardP', 12); // current price
    // Create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(create.status).toBe(200);
    const { id, secret } = await create.json() as any;
    expect(id).toBeTruthy(); expect(secret).toBeTruthy();
    // Add two lots
    const lot1 = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ card_id:'cardP', qty:2, cost_usd:15 }) });
    expect(lot1.status).toBe(200);
    const lot2 = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ card_id:'cardP', qty:1, cost_usd:7 }) });
    expect(lot2.status).toBe(200);
    // Query
    const res = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    const j = await res.json() as any;
    expect(j.ok).toBe(true);
    // Market value: 3 * 12 = 36 ; cost basis 15 + 7 = 22 ; unrealized 14
    expect(j.totals.market_value).toBe(36);
    expect(j.totals.cost_basis).toBe(22);
    expect(j.totals.unrealized).toBe(14);
  });
});
