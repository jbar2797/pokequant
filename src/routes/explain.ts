import { router } from '../router';
import { json } from '../lib/http';
import type { Env } from '../lib/types';

// Public explainability endpoint: /api/card/factors?id=card123
// Returns latest factor component values and a simple normalized weight contribution breakdown.

export function registerExplainRoutes() {
  router.add('GET','/api/card/factors', async ({ env, req, url }) => {
    const id = (url.searchParams.get('id')||'').trim();
    if (!id) return json({ ok:false, error:'id_required' },400);
    // Ensure tables (defensive for pristine db)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signal_components_daily (card_id TEXT, as_of DATE, ts7 REAL, ts30 REAL, dd REAL, vol REAL, z_svi REAL, regime_break INTEGER, liquidity REAL, scarcity REAL, mom90 REAL, PRIMARY KEY(card_id, as_of));`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id, as_of));`).run();
    const comp = await env.DB.prepare(`SELECT * FROM signal_components_daily WHERE card_id=? ORDER BY as_of DESC LIMIT 1`).bind(id).all();
    if (!(comp.results||[]).length) return json({ ok:true, card_id:id, components:null });
    const row: any = comp.results![0];
    const as_of = row.as_of;
    const sig = await env.DB.prepare(`SELECT score, signal, edge_z, exp_ret, exp_sd FROM signals_daily WHERE card_id=? AND as_of=?`).bind(id, as_of).all();
    const sigRow: any = (sig.results||[])[0] || {};
    // Collect numeric factors
    const factors: Record<string, number> = {};
    for (const k of ['ts7','ts30','dd','vol','z_svi','liquidity','scarcity','mom90']) {
      if (row[k] !== undefined && row[k] !== null && Number.isFinite(Number(row[k]))) factors[k] = Number(row[k]);
    }
    // Derive simple magnitude weights (absolute value) normalized
    const absVals = Object.entries(factors).map(([k,v])=> [k, Math.abs(v||0)] as [string, number]);
    const absSum = absVals.reduce((s, [,v])=> s+v, 0) || 1;
    const contributions: Record<string, number> = {};
    let running = 0;
    for (let i=0;i<absVals.length;i++) {
      const [k,v] = absVals[i];
      if (i === absVals.length -1) {
        contributions[k] = +(1 - running).toFixed(6); // force sum exactly 1
      } else {
        const w = v/absSum;
        const r = +w.toFixed(6);
        contributions[k] = r;
        running += r;
      }
    }
    return json({ ok:true, card_id:id, as_of, score: sigRow.score ?? null, signal: sigRow.signal ?? null, factors, contributions });
  });
}

registerExplainRoutes();
