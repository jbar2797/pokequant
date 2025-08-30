import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Request metrics instrumentation smoke test

describe('Request metrics', () => {
  it('increments status metrics after requests', async () => {
    const r1 = await SELF.fetch('https://example.com/api/universe');
    expect(r1.status).toBe(200);
    // Hit an unknown path to generate a 404 (should be handled gracefully)
    const r404 = await SELF.fetch('https://example.com/does-not-exist');
    expect([404, 200, 301, 302]).toContain(r404.status); // allow fallback variations
    const metrics = await SELF.fetch('https://example.com/admin/metrics', { headers: { 'x-admin-token':'test-admin' }});
    expect(metrics.status).toBe(200);
    const j:any = await metrics.json();
    const names = (j.rows||[]).map((r:any)=> r.metric || r.metric_name || r.metric);
    // At minimum we expect req.total and req.status.2xx
    expect(names.some((m:string)=> m === 'req.total')).toBe(true);
    expect(names.some((m:string)=> m === 'req.status.2xx')).toBe(true);
  });
});
