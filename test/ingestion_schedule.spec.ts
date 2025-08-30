import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Ingestion schedule', () => {
  it('upserts schedule entries and lists them', async () => {
    const up = await SELF.fetch('https://example.com/admin/ingestion-schedule', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', frequency_minutes: 60 }) });
    const uj:any = await up.json();
    expect(uj.ok).toBe(true);
    const list = await SELF.fetch('https://example.com/admin/ingestion-schedule', { headers:{'x-admin-token':'test-admin'} });
    const lj:any = await list.json();
    expect(lj.ok).toBe(true);
    expect(lj.rows.some((r:any)=> r.dataset==='prices_daily')).toBe(true);
  });
});
