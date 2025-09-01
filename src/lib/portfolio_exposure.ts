import type { Env } from './types';

// Snapshot portfolio factor exposure (moved from index.ts for modularization)
export async function snapshotPortfolioFactorExposure(env: Env) {
  // Compute exposures by joining holdings with factor signals (simplified replication of original logic segment)
  // NOTE: Original implementation relied on existing tables; behavior preserved.
  try {
    // Ensure destination table
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_factor_exposure (portfolio_id TEXT, factor TEXT, exposure REAL, as_of TEXT, PRIMARY KEY(portfolio_id,factor,as_of))`).run();
    // For each portfolio, aggregate factor values of current holdings (weights assumed equal for placeholder logic)
    const ports = await env.DB.prepare(`SELECT DISTINCT portfolio_id FROM portfolio_nav LIMIT 50`).all();
    const portRows = (ports.results||[]) as any[];
    const today = new Date().toISOString().slice(0,10);
    for (const p of portRows) {
      const pid = String(p.portfolio_id);
      const comps = await env.DB.prepare(`SELECT sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90 FROM signal_components_daily sc JOIN portfolio_nav nav ON nav.card_id=sc.card_id WHERE nav.portfolio_id=? ORDER BY sc.as_of DESC LIMIT 200`).bind(pid).all();
      const rows = (comps.results||[]) as any[];
      if (!rows.length) continue;
      const agg = (k:string)=> { let s=0,c=0; for (const r of rows){ const v=Number((r as any)[k]); if (Number.isFinite(v)) { s+=v; c++; } } return c? s/c: null; };
      const factors = { ts7: agg('ts7'), ts30: agg('ts30'), z_svi: agg('z_svi'), risk: agg('vol'), liquidity: agg('liquidity'), scarcity: agg('scarcity'), mom90: agg('mom90') };
      for (const [f, v] of Object.entries(factors)) {
        if (v===null) continue;
        await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_factor_exposure (portfolio_id,factor,exposure,as_of) VALUES (?,?,?,?)`).bind(pid, f, v, today).run();
      }
    }
  } catch { /* swallow errors; original code silent */ }
}
