import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Retention config CRUD', () => {
  it('lists empty config then upserts and lists', async () => {
    let res = await SELF.fetch('https://example.com/admin/retention/config', { headers:{ 'x-admin-token':'test-admin' } });
    expect(res.status).toBe(200);
    let j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);

    res = await SELF.fetch('https://example.com/admin/retention/config', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'metrics_daily', days: 9 }) });
    expect(res.status).toBe(200);
    j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.row && j.row.table_name).toBe('metrics_daily');
    expect(j.row.days).toBe(9);

    res = await SELF.fetch('https://example.com/admin/retention/config', { headers:{ 'x-admin-token':'test-admin' } });
    j = await res.json();
    const found = (j.rows||[]).find((r: any)=> r.table_name==='metrics_daily');
    expect(found && found.days).toBe(9);
  });
});
