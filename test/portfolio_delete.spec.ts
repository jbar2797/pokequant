import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio delete lot', () => {
  it('adds then deletes a lot', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const { id, secret } = await create.json() as any;
    const add = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ card_id:'card1', qty:1, cost_usd:10 }) });
    expect(add.status).toBe(200);
    const p = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    const pj = await p.json() as any;
    const lotId = pj.rows[0].lot_id;
    const del = await SELF.fetch('https://example.com/portfolio/delete-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ lot_id: lotId }) });
    expect(del.status).toBe(200);
    const dj = await del.json() as any;
    expect(dj.deleted).toBe(1);
  });
});
