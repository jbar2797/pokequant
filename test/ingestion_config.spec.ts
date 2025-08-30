import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for ingestion config endpoints

describe('Ingestion config', () => {
  it('upserts and lists ingestion config entries', async () => {
    const up = await SELF.fetch('https://example.com/admin/ingestion/config', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', source:'external-mock', cursor:'2025-01-01', enabled:true, meta:{ note:'test' } }) });
    expect(up.status).toBe(200);
    const j:any = await up.json();
    expect(j.ok).toBe(true);
    const list = await SELF.fetch('https://example.com/admin/ingestion/config', { headers:{'x-admin-token':'test-admin'} });
    expect(list.status).toBe(200);
    const lj:any = await list.json();
    expect(lj.ok).toBe(true);
    expect(lj.rows.some((r:any)=> r.dataset==='prices_daily' && r.source==='external-mock')).toBe(true);
  });
});
