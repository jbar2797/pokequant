import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies slo_ratios object aggregates good/breach counts correctly and computes breach_ratio

describe('SLO ratios aggregation', () => {
  it('computes breach_ratio after good + breach events', async () => {
  // Warm-up (migrations/metrics table creation) to avoid classifying first measured call as breach due to one-time init latency.
  await SELF.fetch('https://example.com/admin/test/sleep?ms=0', { headers:{ 'x-admin-token':'test-admin' } });
  // Configure threshold (200ms) so a small 10ms sleep is "good" and a large 500ms sleep (capped) is a deterministic breach.
  const route = '/admin/test/sleep';
  const set = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route, threshold_ms: 200 }) });
  expect(set.status).toBe(200);
  // Good (10ms sleep < 200ms threshold)
  await SELF.fetch('https://example.com/admin/test/sleep?ms=10', { headers:{ 'x-admin-token':'test-admin' } });
  // Breach (500ms sleep > 200ms threshold; route clamps >500)
  await SELF.fetch('https://example.com/admin/test/sleep?ms=500', { headers:{ 'x-admin-token':'test-admin' } });
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
