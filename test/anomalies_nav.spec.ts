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
  it('creates a backfill job and lists it', async () => {
    const create = await SELF.fetch('https://example.com/admin/backfill', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', days:5 }) });
    expect(create.status).toBe(200);
    const cj: any = await create.json();
    expect(cj.ok).toBe(true);
    expect(cj.job.status).toBe('completed');
    const list = await SELF.fetch('https://example.com/admin/backfill', { headers:{'x-admin-token':'test-admin'} });
    expect(list.status).toBe(200);
    const lj: any = await list.json();
    expect(lj.rows.length).toBeGreaterThan(0);
  });
});
