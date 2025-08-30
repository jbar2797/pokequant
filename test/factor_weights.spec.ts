import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Factor weights admin endpoints

describe('Factor weights', () => {
  it('can upsert and list weights', async () => {
    const up = await SELF.fetch('https://example.com/admin/factor-weights', {
      method: 'POST',
      headers: { 'x-admin-token':'test-admin', 'content-type':'application/json' },
      body: JSON.stringify({ version: 'testv1', weights: [
        { factor: 'ts7', weight: 0.5 },
        { factor: 'ts30', weight: 0.3 },
        { factor: 'z_svi', weight: 0.15 },
        { factor: 'risk', weight: 0.05 }
      ] })
    });
    expect(up.status).toBe(200);
    const jl = await up.json() as any;
    expect(jl.ok).toBe(true);
    const list = await SELF.fetch('https://example.com/admin/factor-weights', { headers: { 'x-admin-token':'test-admin' }});
    expect(list.status).toBe(200);
    const j2 = await list.json() as any;
    expect(j2.ok).toBe(true);
    expect(Array.isArray(j2.rows)).toBe(true);
    expect(j2.rows.some((r:any)=> r.version==='testv1')).toBe(true);
  });
});
