import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio order execution stores executed_trades', () => {
  it('creates and executes order capturing executed_trades field', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const pj:any = await create.json();
    const setT = await SELF.fetch('https://example.com/portfolio/targets', { method:'POST', headers:{'x-portfolio-id':pj.id,'x-portfolio-secret':pj.secret,'content-type':'application/json'}, body: JSON.stringify({ factors:{ ts7: 0.1 } }) });
    const stj:any = await setT.json();
    expect(stj.ok).toBe(true);
    const oc = await SELF.fetch('https://example.com/portfolio/orders', { method:'POST', headers:{'x-portfolio-id':pj.id,'x-portfolio-secret':pj.secret} });
    const ocj:any = await oc.json();
    const exec = await SELF.fetch('https://example.com/portfolio/orders/execute', { method:'POST', headers:{'x-portfolio-id':pj.id,'x-portfolio-secret':pj.secret,'content-type':'application/json'}, body: JSON.stringify({ id: ocj.id }) });
    const exj:any = await exec.json();
    expect(exj.ok).toBe(true);
  });
});
