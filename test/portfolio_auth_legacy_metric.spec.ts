import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Validates that using legacy plaintext secret (without hash) increments portfolio.auth_legacy metric.

describe('Portfolio legacy auth metric', () => {
  it('increments metric when authenticating with plaintext secret lacking hash', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(create.status).toBe(200);
    const { id, secret } = await create.json() as any;
    // Capture baseline metric count (may be absent)
    const beforeResp = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' }});
    expect(beforeResp.status).toBe(200);
    const before = await beforeResp.json() as any;
    const prevRow = (before.rows||[]).find((r:any)=> r.metric === 'portfolio.auth_legacy');
    const prev = prevRow ? Number(prevRow.count) : 0;
    // Force legacy by nulling hash
    const force = await SELF.fetch('https://example.com/admin/portfolio/force-legacy', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ id }) });
    expect(force.status).toBe(200);
    // Portfolio request (should succeed) triggers legacy metric increment
    const port = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    expect(port.status).toBe(200);
    const afterResp = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' }});
    expect(afterResp.status).toBe(200);
    const after = await afterResp.json() as any;
    const afterRow = (after.rows||[]).find((r:any)=> r.metric === 'portfolio.auth_legacy');
    const next = afterRow ? Number(afterRow.count) : 0;
    expect(next).toBe(prev + 1);
  });
});
