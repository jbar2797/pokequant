import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio order detail', () => {
  it('returns suggestions & executed trades', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const pj: any = await create.json();

    const orderCreate = await SELF.fetch('https://example.com/portfolio/orders', { method:'POST', headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const ocj: any = await orderCreate.json();
    expect(ocj.ok).toBe(true);

    // Fetch detail
    const detail = await SELF.fetch(`https://example.com/portfolio/orders/detail?id=${ocj.id}`, { headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const dj: any = await detail.json();
    expect(dj.ok).toBe(true);
    expect(dj.suggestions).toBeDefined();
    expect(dj.suggestions.factor_deltas && typeof dj.suggestions.factor_deltas === 'object').toBe(true);

    // Execute then fetch again
    await SELF.fetch('https://example.com/portfolio/orders/execute', { method:'POST', headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret, 'content-type':'application/json' }, body: JSON.stringify({ id: ocj.id }) });
    const detail2 = await SELF.fetch(`https://example.com/portfolio/orders/detail?id=${ocj.id}`, { headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const d2: any = await detail2.json();
    expect(d2.executed_trades).toBeDefined();
  });
});
