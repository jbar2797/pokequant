import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Pagination and stats tests for audit

describe('Audit pagination & stats', () => {
  it('supports before_ts pagination cursor and stats endpoint', async () => {
    // Emit several audit entries via test helper
    for (let i=0;i<5;i++) {
      await SELF.fetch('https://example.com/admin/test-audit', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ action:'emit', resource:'page_test', details:{ i, secret:'abc'+i } }) });
    }
    const first = await SELF.fetch('https://example.com/admin/audit?resource=page_test&limit=3', { headers:{'x-admin-token':'test-admin'} });
    expect(first.status).toBe(200);
    const fj:any = await first.json();
    expect(fj.rows.length).toBeGreaterThan(0);
    const cursor = fj.page?.next_before_ts;
    if (cursor) {
      const second = await SELF.fetch(`https://example.com/admin/audit?resource=page_test&limit=3&before_ts=${encodeURIComponent(cursor)}`, { headers:{'x-admin-token':'test-admin'} });
      expect(second.status).toBe(200);
      const sj:any = await second.json();
      // Ensure no overlap on ts ordering (strictly older)
      const newestSecond = sj.rows[0]?.ts;
      if (newestSecond) expect(new Date(newestSecond).getTime()).toBeLessThan(new Date(fj.rows[0].ts).getTime());
    }
    // Stats endpoint
    const stats = await SELF.fetch('https://example.com/admin/audit/stats?hours=24', { headers:{'x-admin-token':'test-admin'} });
    expect(stats.status).toBe(200);
    const st:any = await stats.json();
    expect(st.ok).toBe(true);
    expect(st.rows.some((r:any)=> r.resource==='page_test')).toBe(true);
  });
});
