import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// /admin/metrics-export endpoint test

describe('Admin metrics export', () => {
  it('exports current day metrics in Prometheus format', async () => {
    // Generate a few metrics via normal requests
    const r1 = await SELF.fetch('https://example.com/api/universe');
    expect(r1.status).toBe(200);
    const r2 = await SELF.fetch('https://example.com/api/cards');
    expect([200,404]).toContain(r2.status); // cards may require data; allow 404 edge
  // Generate latency metric by invoking an admin endpoint (latency tracking)
  const r3 = await SELF.fetch('https://example.com/admin/version', { headers: { 'x-admin-token':'test-admin' }});
  expect(r3.status).toBe(200);

    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers: { 'x-admin-token':'test-admin' }});
    expect(resp.status).toBe(200);
    const text = await resp.text();
    // Basic Prometheus exposition header lines
    expect(text).toMatch(/# HELP pq_metric/);
    expect(text).toMatch(/# TYPE pq_metric counter/);
    // At least one counter metric line
    const lines = text.split(/\n/);
    const counterLines = lines.filter(l => l.startsWith('pq_metric'));
    expect(counterLines.length).toBeGreaterThan(0);
    for (const line of counterLines.slice(0,3)) {
      expect(line).toMatch(/^pq_metric\{name="[A-Za-z0-9_:]+"\} \d+(?:\.\d+)?$/);
    }
  // Latency gauge family present with quantile label
  expect(text).toMatch(/# TYPE pq_latency gauge/);
  const latencyLines = lines.filter(l => l.startsWith('pq_latency'));
  expect(latencyLines.length).toBeGreaterThan(0);
  expect(latencyLines[0]).toMatch(/^pq_latency\{name="[A-Za-z0-9_:]+",quantile="p(50|95)"\} \d+\.\d{2}$/);
  // Latency bucket counters (optional if very early in day / minimal traffic)
  const bucketHeader = /# TYPE pq_latency_bucket counter/;
  if (bucketHeader.test(text)) {
    const bucketLines = lines.filter(l => l.startsWith('pq_latency_bucket'));
    expect(bucketLines.length).toBeGreaterThan(0);
    expect(bucketLines[0]).toMatch(/^pq_latency_bucket\{name="[A-Za-z0-9_:]+",bucket="(lt50|lt100|lt250|lt500|lt1000|gte1000)"\} \d+$/);
  }
  // Error/status families (may be zero if no errors, but headers appear after some error-inducing tests here)
  // Trigger a known 403 to ensure at least one error_status counter increments
  const errFetch = await SELF.fetch('https://example.com/admin/version');
  expect([401,403]).toContain(errFetch.status);
  const resp2 = await SELF.fetch('https://example.com/admin/metrics-export', { headers: { 'x-admin-token':'test-admin' }});
  const text2 = await resp2.text();
  expect(text2).toMatch(/# TYPE pq_status counter/);
  });

  it('rejects missing admin token', async () => {
    const r = await SELF.fetch('https://example.com/admin/metrics-export');
    expect(r.status).toBe(403);
  });
});
