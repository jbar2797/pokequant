import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for anomaly resolution workflow

describe('Anomalies resolution', () => {
  it('lists anomalies and resolves one', async () => {
    // Insert a synthetic anomaly row directly (simulate detection)
    const id = crypto.randomUUID();
    const d = new Date().toISOString().slice(0,10);
    const ins = await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'anomalies', rows:[ { id, as_of:d, card_id:'card1', kind:'price_spike', magnitude:0.3, created_at:new Date().toISOString() } ] }) });
    expect(ins.status).toBe(200);
    const list = await SELF.fetch('https://example.com/admin/anomalies?status=open', { headers:{'x-admin-token':'test-admin'} });
    expect(list.status).toBe(200);
    const lj: any = await list.json();
    const row = (lj.rows||[]).find((r:any)=> r.id===id);
    expect(row).toBeTruthy();
    const res = await SELF.fetch('https://example.com/admin/anomalies/resolve', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ id, action:'ack', note:'checked' }) });
    expect(res.status).toBe(200);
    const list2 = await SELF.fetch('https://example.com/admin/anomalies?status=resolved', { headers:{'x-admin-token':'test-admin'} });
    const l2: any = await list2.json();
    expect((l2.rows||[]).some((r:any)=> r.id===id && r.resolved===1)).toBe(true);
  });
});
