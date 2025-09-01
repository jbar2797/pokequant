import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Validates retention by inserting synthetic old metric rows then invoking /admin/retention purge.

function daysAgo(n:number) { const d = new Date(Date.now()-n*86400000); return d.toISOString().slice(0,10); }

describe('Metrics retention', () => {
  it('purges metrics older than default window', async () => {
    const oldDay = daysAgo(30);
  const recentDay = daysAgo(0); // today; 0-day window retains today only
    // Insert synthetic metrics
    let r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ d: oldDay, metric:'test.old', count:5 }) });
    expect(r.status).toBe(200);
    r = await SELF.fetch('https://example.com/admin/test/metric/insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ d: recentDay, metric:'test.recent', count:3 }) });
    expect(r.status).toBe(200);
    // Confirm exists
    let existsOld = await SELF.fetch(`https://example.com/admin/test/metric/exists?d=${oldDay}&metric=test.old`, { headers:{ 'x-admin-token':'test-admin' } });
    expect(existsOld.status).toBe(200);
  // Force retention config for metrics_daily to 0 days to guarantee purge of old metric
  let cfg = await SELF.fetch('https://example.com/admin/retention/config', { headers:{ 'x-admin-token':'test-admin' } });
  expect(cfg.status).toBe(200);
  const up = await SELF.fetch('https://example.com/admin/retention/config', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'metrics_daily', days: 0 }) });
  expect(up.status).toBe(200);
  const purge = await SELF.fetch('https://example.com/admin/retention', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({}) });
    expect(purge.status).toBe(200);
  // Old metric must be gone (hard assertion now that window=0)
    existsOld = await SELF.fetch(`https://example.com/admin/test/metric/exists?d=${oldDay}&metric=test.old`, { headers:{ 'x-admin-token':'test-admin' } });
    const oldJson: any = await existsOld.json();
    // Accept either not found or still present if retention window configured differently; ensure recent still exists
    const existsRecent = await SELF.fetch(`https://example.com/admin/test/metric/exists?d=${recentDay}&metric=test.recent`, { headers:{ 'x-admin-token':'test-admin' } });
    const recentJson: any = await existsRecent.json();
    expect(recentJson.exists).toBe(true);
  expect(oldJson.exists).toBe(false);
  }, 30000);
});
