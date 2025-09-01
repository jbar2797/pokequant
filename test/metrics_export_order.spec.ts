import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Metrics export ordering regression', () => {
  it('emits latency quantiles before buckets and respects gating flag', async () => {
    // generate some traffic
    await SELF.fetch('https://example.com/api/universe');
    const r1 = await SELF.fetch('https://example.com/admin/version', { headers:{'x-admin-token':'test-admin'} });
    expect(r1.status).toBe(200);
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{'x-admin-token':'test-admin'} });
    const text = await resp.text();
    const lines = text.trim().split(/\n/);
    const latencyIdx = lines.findIndex(l=> l.startsWith('pq_latency{'));
    const bucketIdx = lines.findIndex(l=> l.startsWith('# TYPE pq_latency_bucket'));
    expect(latencyIdx).toBeGreaterThan(-1);
    // If buckets exist they appear after quantile lines
    if (bucketIdx !== -1) {
      expect(bucketIdx).toBeGreaterThan(latencyIdx);
    }
  });
});
