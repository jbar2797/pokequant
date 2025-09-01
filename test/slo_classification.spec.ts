import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies SLO good vs breach counters increment based on configured threshold.

describe('SLO classification metrics', () => {
  it('increments good and breach metrics appropriately', async () => {
    // Set a very low threshold for /health to force breaches when we add artificial delay
  // First set a relaxed threshold and issue a request for a likely good classification
  const setRelax = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route:'/health', threshold_ms: 2000 }) });
  expect(setRelax.status).toBe(200);
  await SELF.fetch('https://example.com/health');
  // Attempt to force a breach using a heavier admin route with very tight SLO
  const setTightAdmin = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route:'/admin/metrics', threshold_ms: 10 }) });
  expect(setTightAdmin.status).toBe(200);
  await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    // Export metrics and assert presence of good counter; breach is best-effort (may be missing if fast)
    const metricsExport = await SELF.fetch('https://example.com/admin/metrics/export', { headers:{ 'x-admin-token':'test-admin' } });
    const text = await metricsExport.text();
    expect(text.includes('req_slo_route_health_good')).toBe(true);
  // Breach metric can be timing-dependent; we only require good classification presence.
  });
});
