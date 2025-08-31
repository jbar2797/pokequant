import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Anomalies pagination', () => {
  it('paginates anomalies with before_created_at cursor', async () => {
    // Seed 5 anomalies via test-insert (limit default 100 so need > limit? We'll use a lower manual limit)
    const base = Date.now();
    const rows = Array.from({length:5}).map((_,i)=> ({
      id: crypto.randomUUID(),
      as_of: '2025-01-0'+((i%9)+1),
      card_id: 'CARD-'+i,
      kind: 'test',
      magnitude: i*1.1,
      created_at: new Date(base - i*1000).toISOString()
    }));
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'anomalies', rows }) });
    const first = await SELF.fetch('https://example.com/admin/anomalies?limit=2', { headers:{'x-admin-token':'test-admin'} });
    expect(first.status).toBe(200);
    const j1:any = await first.json();
    expect(j1.rows.length).toBe(2);
    expect(j1.page.next_before_created_at).toBeTruthy();
    const second = await SELF.fetch(`https://example.com/admin/anomalies?limit=2&before_created_at=${encodeURIComponent(j1.page.next_before_created_at)}`, { headers:{'x-admin-token':'test-admin'} });
    const j2:any = await second.json();
    expect(j2.rows.length).toBeGreaterThan(0);
    // Ensure no overlap (ids unique between pages)
    const ids1 = new Set(j1.rows.map((r:any)=> r.id));
    for (const r of j2.rows) expect(ids1.has(r.id)).toBe(false);
  });
});
