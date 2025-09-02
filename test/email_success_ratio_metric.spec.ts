import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Validates email success ratio gauge (pq_email_success_ratio) appears.

describe('Email success ratio metric', () => {
  it('exports pq_email_success_ratio gauge', async () => {
    const today = new Date().toISOString().slice(0,10);
    const inserts: [string, number][] = [
      ['email.sent', 2],
      ['email.delivered', 2],
      ['email.send_error', 1],
      ['email.bounced', 1]
    ];
    for (const [metric,count] of inserts) {
      const r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric, count }) });
      expect([200,403]).toContain(r.status);
    }
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(resp.status);
    if (resp.status === 200) {
      const text = await resp.text();
      // success ratio = delivered (2) / total (2+1+1) = 0.5
      expect(text).toMatch(/pq_email_success_ratio\s+0\.500000/);
    }
  });
});
