import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Basic integration test for portfolio targets & orders MVP

describe('Portfolio targets & orders', () => {
  it('can set targets, create order, list and execute', async () => {
    // Create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const pj: any = await create.json();
    expect(pj.id).toBeDefined();

    // Set factor targets
    const setT = await SELF.fetch('https://example.com/portfolio/targets', { method:'POST', headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret, 'content-type':'application/json' }, body: JSON.stringify({ factors:{ ts7:0.5, scarcity:-0.2 } }) });
    const stj: any = await setT.json();
    expect(stj.ok).toBe(true);

    // List targets
    const listT = await SELF.fetch('https://example.com/portfolio/targets', { headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const ltj: any = await listT.json();
    expect(ltj.ok).toBe(true);
    expect(ltj.rows.length).toBeGreaterThanOrEqual(2);

    // Create order
    const orderCreate = await SELF.fetch('https://example.com/portfolio/orders', { method:'POST', headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const ocj: any = await orderCreate.json();
    expect(ocj.ok).toBe(true);
    expect(ocj.id).toBeDefined();
    expect(ocj.suggestions).toBeDefined();

    // List orders
    const orders = await SELF.fetch('https://example.com/portfolio/orders', { headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    const oj: any = await orders.json();
    expect(oj.ok).toBe(true);
    expect(oj.rows.some((r:any)=> r.id === ocj.id)).toBe(true);

    // Execute order
    const exec = await SELF.fetch('https://example.com/portfolio/orders/execute', { method:'POST', headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret, 'content-type':'application/json' }, body: JSON.stringify({ id: ocj.id }) });
    const exj: any = await exec.json();
    expect(exj.ok).toBe(true);
    expect(exj.status).toBe('executed');
  });
});
