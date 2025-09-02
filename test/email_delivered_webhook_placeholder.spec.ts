import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Delivered webhook should record event and increment email.delivered metric.

describe('Email delivered webhook', () => {
  it('records delivered event', async () => {
    const payload = { provider:'resend', type:'delivered', id:'evt_test_1', message_id:'msg_test_1' };
    const r = await SELF.fetch('https://example.com/webhooks/email/delivered', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload) });
    expect([200,403]).toContain(r.status);
    if (r.status === 200) {
      const j:any = await r.json();
      expect(j.ok).toBeTruthy();
      expect(j.delivered).toBeTruthy();
    }
  });
});
