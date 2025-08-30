import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Alert snooze test

describe('Alert snooze', () => {
  it('creates an alert with snooze and does not fire while suppressed', async () => {
    const create = await SELF.fetch('https://example.com/alerts/create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email:'a@b.test', card_id:'cardS', threshold: 1000, snooze_minutes: 10 }) });
    const cj:any = await create.json();
    expect(cj.ok).toBe(true);
    // Force run alerts
    const run = await SELF.fetch('https://example.com/admin/run-alerts', { method:'POST', headers:{'x-admin-token':'test-admin'} });
    const rj:any = await run.json();
    expect(rj.ok).toBe(true);
    // For large threshold immediate price likely below threshold; suppressed should prevent fire count >0
    // Accept either 0 or low fired if dataset empty, but ensure not more than 0 when suppressed
    expect(rj.fired === 0).toBe(true);
  });
});
