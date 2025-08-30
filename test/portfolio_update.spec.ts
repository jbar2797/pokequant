import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio update lot', () => {
  it('updates qty and cost', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const { id, secret } = await create.json() as any;
    const add = await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ card_id:'card1', qty:2, cost_usd:20 }) });
    expect(add.status).toBe(200);
    const port = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    const pj = await port.json() as any;
    const lotId = pj.rows[0].lot_id;
    const upd = await SELF.fetch('https://example.com/portfolio/update-lot', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret, 'content-type':'application/json' }, body: JSON.stringify({ lot_id: lotId, qty:3, cost_usd:33 }) });
    expect(upd.status).toBe(200);
    const upj = await upd.json() as any;
    expect(upj.updated).toBe(1);
  });
});
