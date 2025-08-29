import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Error path tests to ensure standardized error model is returned

describe('Errors', () => {
  it('alerts create missing fields', async () => {
    const r = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.ok).toBe(false);
    expect(j.error).toBe('email_and_card_id_required');
  });
  it('alerts create invalid threshold', async () => {
    const r = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({ email:'a@test', card_id:'x', threshold:'notnum' }) });
    const j = await r.json() as any;
    expect(j.ok).toBe(false);
    expect(j.error).toBe('threshold_invalid');
  });
  it('portfolio forbidden', async () => {
    const r = await SELF.fetch('https://example.com/portfolio');
    expect(r.status).toBe(403);
    const j = await r.json() as any;
    expect(j.error).toBe('forbidden');
  });
});
