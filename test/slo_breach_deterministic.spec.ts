import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Deterministic SLO breach using helper sleep route.

describe('SLO deterministic breach', () => {
  it('produces breach metric with tight threshold', async () => {
    // Set relaxed threshold first
    let res = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route:'/admin/test/sleep', threshold_ms: 200 }) });
    expect(res.status).toBe(200);
    await SELF.fetch('https://example.com/admin/test/sleep?ms=10', { headers:{ 'x-admin-token':'test-admin' } });
    // Tight threshold 5ms (minimum allowed is 10 so use 10) then call with 50ms sleep
  res = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route:'/admin/test/sleep', threshold_ms: 10 }) });
  expect(res.status).toBe(200);
  // Two slow calls to be robust against any race in SLO cache invalidation
  await SELF.fetch('https://example.com/admin/test/sleep?ms=80', { headers:{ 'x-admin-token':'test-admin' } });
  await SELF.fetch('https://example.com/admin/test/sleep?ms=60', { headers:{ 'x-admin-token':'test-admin' } });
    const metricsExport = await SELF.fetch('https://example.com/admin/metrics/export', { headers:{ 'x-admin-token':'test-admin' } });
    const text = await metricsExport.text();
  expect(text.includes('req_slo_route_admin_test_sleep_breach')).toBe(true);
  expect(text.includes('req_slo_route_admin_test_sleep_good')).toBe(true);
  });
});
