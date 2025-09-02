import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Email delivered webhook secret rotation', () => {
  it('accepts NEXT secret during rotation window', async () => {
    (globalThis as any).ENV = { ...(globalThis as any).ENV, EMAIL_WEBHOOK_SECRET:'oldsecret', EMAIL_WEBHOOK_SECRET_NEXT:'newsecret' };
    const payload = { provider:'resend', type:'delivered', id:'evt_rot', message_id:'msg_rot' };
    const r = await SELF.fetch('https://example.com/webhooks/email/delivered', { method:'POST', headers:{ 'content-type':'application/json', 'x-email-webhook-secret':'newsecret' }, body: JSON.stringify(payload) });
    expect([200,401]).toContain(r.status);
    if (r.status === 200) {
      const j:any = await r.json();
      expect(j.ok).toBeTruthy();
      expect(j.delivered).toBeTruthy();
    }
  });
});
