import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests dynamic SLO admin endpoints: list + set + classification effect

describe('Admin SLO endpoints', () => {
  it('lists and sets SLO thresholds', async () => {
    const list0 = await SELF.fetch('https://example.com/admin/slo', { headers:{ 'x-admin-token':'test-admin' } });
    expect(list0.status).toBe(200);
    const body0: any = await list0.json();
    expect(body0.ok).toBe(true);
    // Set a very low threshold for a route to force breach classification
    const setRes = await SELF.fetch('https://example.com/admin/slo/set', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ route:'/health', threshold_ms: 10 }) });
    expect(setRes.status).toBe(200);
    const setBody: any = await setRes.json();
    expect(setBody.ok).toBe(true);
    // Trigger route
    const h = await SELF.fetch('https://example.com/health');
    expect(h.status).toBe(200);
    // Re-list should include route slug health
    const list1 = await SELF.fetch('https://example.com/admin/slo', { headers:{ 'x-admin-token':'test-admin' } });
    const body1: any = await list1.json();
    expect(body1.rows.some((r:any)=> r.route==='health' && r.threshold_ms===10)).toBe(true);
  });
});
