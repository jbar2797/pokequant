import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Anomalies & NAV endpoints

describe('Anomalies & NAV', () => {
  it('lists anomalies and portfolio nav (may be empty)', async () => {
    const anomalies = await SELF.fetch('https://example.com/admin/anomalies', { headers: { 'x-admin-token':'test-admin' }});
    expect(anomalies.status).toBe(200);
    const nav = await SELF.fetch('https://example.com/admin/portfolio-nav', { headers: { 'x-admin-token':'test-admin' }});
    expect(nav.status).toBe(200);
    const backfill = await SELF.fetch('https://example.com/admin/backfill', { method: 'POST', headers: { 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ dataset:'prices', days:30 }) });
    expect(backfill.status).toBe(200);
  });
});
