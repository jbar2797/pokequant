import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests the /portfolio/scenario endpoint for what-if factor exposures

describe('Portfolio scenario what-if', () => {
  it('computes scenario exposures and deltas', async () => {
    // Create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(create.status).toBe(200);
    const pj:any = await create.json();
    const pid = pj.id; const secret = pj.secret;
    const today = new Date().toISOString().slice(0,10);
    // Insert second card & components so exposures can change
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'cards', rows:[{ id:'cardS2', name:'S2', set_name:'Set', rarity:'Rare' }] }) });
    // Provide price + signal components for primary seed card (card1 from ensureTestSeed) and new card
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{ 'x-admin-token':'test-admin','content-type':'application/json' }, body: JSON.stringify({ table:'signal_components_daily', rows:[{ card_id:'card1', as_of:today, ts7:0.1, ts30:0.2, z_svi:1.0, vol:0.3, liquidity:3, scarcity:0.5, mom90:0.05 }, { card_id:'cardS2', as_of:today, ts7:0.5, ts30:0.6, z_svi:0.2, vol:0.4, liquidity:2, scarcity:0.7, mom90:0.15 }] }) });
    // Add lots (card1 quantity 10)
    await SELF.fetch('https://example.com/portfolio/add-lot', { method:'POST', headers:{ 'x-portfolio-id':pid, 'x-portfolio-secret':secret, 'content-type':'application/json' }, body: JSON.stringify({ card_id:'card1', qty:10, cost_usd:100 }) });
    // Scenario: add cardS2 qty 5 (absolute)
    const scen = await SELF.fetch('https://example.com/portfolio/scenario', { method:'POST', headers:{ 'x-portfolio-id':pid, 'x-portfolio-secret':secret, 'content-type':'application/json' }, body: JSON.stringify({ lots:[{ card_id:'cardS2', qty:5 }] }) });
    expect(scen.status).toBe(200);
    const sj:any = await scen.json();
    expect(sj.ok).toBe(true);
    expect(sj.current).toBeTruthy();
    expect(sj.scenario).toBeTruthy();
    // Ensure delta for ts7 reflects weighted difference (should be positive)
    if (sj.deltas.ts7 != null) expect(sj.deltas.ts7).toBeGreaterThan(0);
  });
});
