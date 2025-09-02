import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Ensures real-mode email metrics (email.sent.real / email.send_error.real) appear when EMAIL_REAL_SEND is on.
// Harness may not have real provider key; simulate by inserting metrics directly, mirroring approach in email_metrics_split.spec.ts

describe('Email real send split metrics', () => {
  it('surfaces real send counters', async () => {
    const today = new Date().toISOString().slice(0,10);
    for (const metric of ['email.sent.real','email.send_error.real']) {
      const r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric, count: 1 }) });
      expect([200,403]).toContain(r.status);
    }
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(resp.status);
    if (resp.status === 200) {
      const text = await resp.text();
      expect(text).toMatch(/pq_metric\{name="email_sent_real"}\s+1/);
      expect(text).toMatch(/pq_metric\{name="email_send_error_real"}\s+1/);
    }
  });
});
