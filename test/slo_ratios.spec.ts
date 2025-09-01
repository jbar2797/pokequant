import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies slo_ratios object aggregates good/breach counts correctly and computes breach_ratio

describe('SLO ratios aggregation', () => {
  it('computes breach_ratio after good + breach events', async () => {
    // Configure threshold so first fast call is good, second slow call breaches.
    const route = '/admin/test/sleep';
    let res = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route, threshold_ms: 50 }) });
    expect(res.status).toBe(200);
    // Good (10ms sleep)
    await SELF.fetch('https://example.com/admin/test/sleep?ms=10', { headers:{ 'x-admin-token':'test-admin' } });
    // Breach (80ms sleep)
    await SELF.fetch('https://example.com/admin/test/sleep?ms=80', { headers:{ 'x-admin-token':'test-admin' } });
    // Fetch metrics JSON
    const metrics = await SELF.fetch('https://example.com/admin/metrics', { headers:{ 'x-admin-token':'test-admin' } });
    expect(metrics.status).toBe(200);
    const j:any = await metrics.json();
    expect(j.ok).toBe(true);
    expect(j.slo_ratios).toBeTruthy();
    const key = 'admin_test_sleep';
    // slug normalization uses '_' for '/' so expect key
    const entry = j.slo_ratios[key];
    expect(entry).toBeTruthy();
    expect(entry.good + entry.breach).toBeGreaterThanOrEqual(2);
    expect(entry.good).toBeGreaterThanOrEqual(1);
    expect(entry.breach).toBeGreaterThanOrEqual(1);
    expect(entry.breach_ratio).toBeGreaterThan(0);
    expect(entry.breach_ratio).toBeLessThan(1);
  });
});
