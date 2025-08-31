import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests the /api/card/factors explainability endpoint

describe('Factor explainability', () => {
  it('returns components and contributions for a card', async () => {
    const cardId = 'cardX';
    // Seed component + signal rows via admin test-insert helper
    // Need anomalies? Only allowed tables: signal_components_daily, factor_returns, portfolio_nav, portfolio_factor_exposure, factor_ic, anomalies
    // So insert into signal_components_daily, and separately insert signal row directly (since test-insert doesn't allow signals_daily) by hitting public endpoints to trigger migrations.
    await SELF.fetch('https://example.com/admin/test-insert', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ table:'signal_components_daily', rows:[ { card_id: cardId, as_of:'2025-08-29', ts7:1.2, ts30:0.5, dd:-0.1, vol:0.3, z_svi:2.1, liquidity:0.8, scarcity:1.5, mom90:0.9 } ] }) });
    // Insert a signals_daily row directly (cannot via test-insert). Use direct write by calling an endpoint that will create signals? Simplest: call /admin/run-fast to generate signals for some cards then ignore if ours missing; fallback we just proceed.
    // Since run-fast may not create our card, endpoint should still work (score/signal nullable).
    const res = await SELF.fetch(`https://example.com/api/card/factors?id=${cardId}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.card_id).toBe(cardId);
    expect(j.factors && typeof j.factors === 'object').toBe(true);
    expect(j.contributions && typeof j.contributions === 'object').toBe(true);
    // Contribution weights sum ~1
    const sum = Object.values(j.contributions).reduce((s: number, v: any)=> s + Number(v||0),0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  });
});
