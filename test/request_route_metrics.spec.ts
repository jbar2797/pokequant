import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies new per-route slug metrics recorded by enhanced router (lat.route.*, req.route.*)

describe('Per-route metrics wrapper', () => {
  it('records route slug metrics for /api/universe', async () => {
    const r = await SELF.fetch('https://example.com/api/universe');
    expect(r.status).toBe(200);
    const metrics = await SELF.fetch('https://example.com/admin/metrics', { headers: { 'x-admin-token':'test-admin' }});
    expect(metrics.status).toBe(200);
    const body:any = await metrics.json();
    const names = (body.rows||[]).map((x:any)=> x.metric);
    // Expect either req.route.api_universe or latency bucket to have been captured.
    expect(names.some((m:string)=> m === 'req.route.api_universe')).toBe(true);
    // Latency metric may exist; ensure at least one latbucket or lat.route entry for universe.
    const hasLatency = names.some((m:string)=> m.startsWith('lat.route.api_universe')) || names.some((m:string)=> m.startsWith('latbucket.route.api_universe'));
    expect(hasLatency).toBe(true);
  });
});
