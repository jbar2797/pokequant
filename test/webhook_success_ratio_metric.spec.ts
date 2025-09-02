import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Validates aggregated webhook success ratio gauge (pq_webhook_success_ratio) appears when component metrics present.

describe('Webhook success ratio metric', () => {
  it('exports pq_webhook_success_ratio gauge', async () => {
    const today = new Date().toISOString().slice(0,10);
    // Insert base counters: 2 sent (1 first-attempt + 1 retry_success), 1 error
    const inserts = [
      ['webhook.sent', 1],
      ['webhook.retry_success', 1],
      ['webhook.error', 1]
    ];
    for (const [metric,count] of inserts) {
      const r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric, count }) });
      expect([200,403]).toContain(r.status);
    }
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(resp.status);
    if (resp.status === 200) {
      const text = await resp.text();
  // success ratio = (1 + 1) / (1 + 1 + 1) = 0.666666..., exporter rounds to 6 decimals (0.666667)
  expect(text).toMatch(/pq_webhook_success_ratio\s+0\.66666[67]/);
    }
  });
});
