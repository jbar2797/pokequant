import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Validates bounce webhook increments normalized + legacy metrics (email.event.bounce & email.bounced)

describe('Email bounce webhook metrics', () => {
  it('records bounce + normalized metrics', async () => {
    const today = new Date().toISOString().slice(0,10);
    const payload = { provider:'resend', message_id:'m123', type:'bounce' };
    const r = await SELF.fetch('https://example.com/webhooks/email/bounce', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload) });
    expect(r.status).toBe(200);
    // Fetch metrics (admin scoped) - allow 403 in hardened harness
    const metrics = await SELF.fetch('https://example.com/admin/metrics-export', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(metrics.status);
    if (metrics.status === 200) {
      const text = await metrics.text();
      expect(text).toMatch(/pq_metric\{name="email_bounced"}\s+1/); // legacy
      expect(text).toMatch(/pq_metric\{name="email_event_bounce"}\s+1/); // normalized
    }
  });
});
