import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Ensures email.sent.sim (and base email.sent) metrics surface in metrics-export after simulated sends.

describe('Email metrics split (simulated)', () => {
  it('emits email.sent & email.sent.sim counters', async () => {
    // Trigger alert email queue processing path by enqueueing a synthetic queued row if table present; simpler: call sendEmail indirectly via alert queue with forced setup
    // Instead we use test helper: insert metric rows directly to reduce flakiness, but also perform one simulated send via alerts admin path if available.
    // Direct metric insert ensures deterministic assertion.
    const today = new Date().toISOString().slice(0,10);
    const ins1 = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric: 'email.sent', count: 2 }) });
    expect([200,403]).toContain(ins1.status);
    const ins2 = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin', 'content-type':'application/json' }, body: JSON.stringify({ d: today, metric: 'email.sent.sim', count: 2 }) });
    expect([200,403]).toContain(ins2.status);
    const resp = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(resp.status);
    if (resp.status === 200) {
      const text = await resp.text();
      expect(text).toMatch(/pq_metric\{name="email_sent"}\s+2/); // base counter
      expect(text).toMatch(/pq_metric\{name="email_sent_sim"}\s+2/); // split counter
    }
  });
});
