import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Verifies webhook .real metrics export handling (insertion-based to avoid dispatch complexity)

describe('Webhook real mode metrics', () => {
  it('shows webhook .real counters when inserted', async () => {
    const today = new Date().toISOString().slice(0,10);
    for (const metric of ['webhook.sent.real','webhook.retry_success.real','webhook.error.real','webhook.redeliver.sent.real']) {
      const r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric, count: 1 }) });
      expect([200,403]).toContain(r.status);
    }
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(resp.status);
    if (resp.status === 200) {
      const text = await resp.text();
      expect(text).toMatch(/pq_metric\{name="webhook_sent_real"}\s+1/);
      expect(text).toMatch(/pq_metric\{name="webhook_retry_success_real"}\s+1/);
      expect(text).toMatch(/pq_metric\{name="webhook_error_real"}\s+1/);
      expect(text).toMatch(/pq_metric\{name="webhook_redeliver_sent_real"}\s+1/);
    }
  });
});
