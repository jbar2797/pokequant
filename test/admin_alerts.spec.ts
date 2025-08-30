import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests admin alert listing & stats endpoints.

const ADMIN='test-admin';

describe('admin alerts listing & stats', () => {
  it('lists alerts and shows stats', async () => {
    const a1 = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({ email:'aa@test', card_id:'CARD-1', kind:'above_price', threshold:10, snooze_minutes: 1 }) });
    const ja1: any = await a1.json();
    expect(ja1.ok).toBe(true);
    const a2 = await SELF.fetch('https://example.com/alerts/create', { method:'POST', body: JSON.stringify({ email:'bb@test', card_id:'CARD-2', kind:'above_price', threshold:20 }) });
    const ja2: any = await a2.json();
    expect(ja2.ok).toBe(true);

    const listAll = await SELF.fetch('https://example.com/admin/alerts', { headers:{ 'x-admin-token': ADMIN } });
    const jl: any = await listAll.json();
    expect(jl.ok).toBe(true);
    expect(Array.isArray(jl.rows)).toBe(true);
    expect(jl.rows.length).toBeGreaterThanOrEqual(2);

    const stats = await SELF.fetch('https://example.com/admin/alerts/stats', { headers:{ 'x-admin-token': ADMIN } });
    const js: any = await stats.json();
    expect(js.ok).toBe(true);
    expect(js.total).toBeGreaterThanOrEqual(2);
    expect(js.escalation).toHaveProperty('ge5');
  });
});
