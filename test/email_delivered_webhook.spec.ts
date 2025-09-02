import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Delivered webhook should record event and increment email.delivered metric.

describe('Email delivered webhook', () => {
  it('rejects without secret when configured', async () => {
    (globalThis as any).ENV = { ...(globalThis as any).ENV, EMAIL_WEBHOOK_SECRET:'s3cr3t' };
    const payload = { provider:'resend', type:'delivered', id:'evt_noauth', message_id:'msg_noauth' };
    const r = await SELF.fetch('https://example.com/webhooks/email/delivered', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify(payload) });
    expect(r.status).toBe(401);
  });
  it('records delivered event with secret', async () => {
    (globalThis as any).ENV = { ...(globalThis as any).ENV, EMAIL_WEBHOOK_SECRET:'s3cr3t' };
    const payload = { provider:'resend', type:'delivered', id:'evt_sec1', message_id:'msg_sec1' };
    const r = await SELF.fetch('https://example.com/webhooks/email/delivered', { method:'POST', headers:{ 'content-type':'application/json', 'x-email-webhook-secret':'s3cr3t' }, body: JSON.stringify(payload) });
    expect(r.status).toBe(200);
    const j:any = await r.json();
    expect(j.ok).toBeTruthy();
    expect(j.delivered).toBeTruthy();
  });
});
