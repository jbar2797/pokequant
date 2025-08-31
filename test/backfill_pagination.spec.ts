import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Backfill pagination', () => {
  it('paginates backfill jobs using before_created_at cursor', async () => {
    // Create 4 backfill jobs
    for (let i=0;i<4;i++) {
      const r = await SELF.fetch('https://example.com/admin/backfill', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', days:1 }) });
      expect(r.status).toBe(200);
    }
    const first = await SELF.fetch('https://example.com/admin/backfill?limit=2', { headers:{'x-admin-token':'test-admin'} });
    expect(first.status).toBe(200);
    const j1:any = await first.json();
    expect(j1.rows.length).toBe(2);
    const cursor = j1.page.next_before_created_at;
    expect(cursor).toBeTruthy();
    const second = await SELF.fetch(`https://example.com/admin/backfill?limit=2&before_created_at=${encodeURIComponent(cursor)}`, { headers:{'x-admin-token':'test-admin'} });
    const j2:any = await second.json();
    expect(j2.rows.length).toBeGreaterThan(0);
    const ids1 = new Set(j1.rows.map((r:any)=> r.id));
    for (const r of j2.rows) expect(ids1.has(r.id)).toBe(false);
  });
});
