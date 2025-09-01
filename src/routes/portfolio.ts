import { json, err } from '../lib/http';
import { sha256Hex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { portfolioAuth } from '../lib/portfolio_auth';
import type { Env } from '../lib/types';
import { router } from '../router';
import { computePortfolioAttribution } from '../lib/portfolio_attribution';
import { ensureTestSeed } from '../lib/data';
import { PortfolioLotSchema, validate, PortfolioTargetsSchema, PortfolioOrderExecuteSchema } from '../lib/validation';

export function registerPortfolioRoutes(){
  // Create portfolio
  router.add('POST','/portfolio/create', async ({ env }) => {
    await ensureTestSeed(env);
    const id = crypto.randomUUID();
    const secretBytes = new Uint8Array(16); crypto.getRandomValues(secretBytes);
    const secret = Array.from(secretBytes).map(b=> b.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT);`).run();
    const hash = await sha256Hex(secret);
    try { await env.DB.prepare(`ALTER TABLE portfolios ADD COLUMN secret_hash TEXT`).run(); } catch {/* ignore */}
    await env.DB.prepare(`INSERT INTO portfolios (id, secret, secret_hash, created_at) VALUES (?,?,?,datetime('now'))`).bind(id, secret, hash).run();
    await audit(env, { actor_type:'public', action:'create', resource:'portfolio', resource_id:id });
    return json({ id, secret });
  })
  // Add lot
  .add('POST','/portfolio/add-lot', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const body = await req.json().catch(()=>({}));
    const parsed = validate(PortfolioLotSchema, body);
    if (!parsed.ok) return json({ ok:false, error:'invalid_body', details: parsed.errors },400);
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lots (id TEXT PRIMARY KEY, portfolio_id TEXT, card_id TEXT, qty REAL, cost_usd REAL, acquired_at TEXT, note TEXT);`).run();
    const lotId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO lots (id, portfolio_id, card_id, qty, cost_usd, acquired_at) VALUES (?,?,?,?,?,?)`).bind(lotId, pid, parsed.data.card_id, parsed.data.qty, parsed.data.cost_usd, parsed.data.acquired_at || null).run();
    await audit(env, { actor_type:'portfolio', actor_id:pid, action:'add_lot', resource:'lot', resource_id:lotId, details:{ card_id: parsed.data.card_id, qty: parsed.data.qty } });
    return json({ ok:true, lot_id: lotId });
  })
  // Rotate secret
  .add('POST','/portfolio/rotate-secret', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const newBytes = new Uint8Array(16); crypto.getRandomValues(newBytes);
    const newSecret = Array.from(newBytes).map(b=> b.toString(16).padStart(2,'0')).join('');
    const newHash = await sha256Hex(newSecret);
    await env.DB.prepare(`UPDATE portfolios SET secret=?, secret_hash=? WHERE id=?`).bind(newSecret, newHash, pid).run();
    await audit(env, { actor_type:'portfolio', actor_id:pid, action:'rotate_secret', resource:'portfolio', resource_id:pid });
    return json({ ok:true, id: pid, secret: newSecret });
  })
  // Portfolio summary
  .add('GET','/portfolio', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const lots = await env.DB.prepare(`SELECT l.id AS lot_id,l.card_id,l.qty,l.cost_usd,l.acquired_at,(SELECT price_usd FROM prices_daily p WHERE p.card_id=l.card_id ORDER BY as_of DESC LIMIT 1) AS price_usd FROM lots l WHERE l.portfolio_id=?`).bind(pid).all();
    let mv=0, cost=0; for (const r of (lots.results||[]) as any[]) { const px = Number(r.price_usd)||0; mv += px * Number(r.qty); cost += Number(r.cost_usd)||0; }
    return json({ ok:true, totals:{ market_value: mv, cost_basis: cost, unrealized: mv-cost }, rows: lots.results||[] });
  })
  .add('GET','/portfolio/export', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const lots = await env.DB.prepare(`SELECT * FROM lots WHERE portfolio_id=?`).bind(pid).all();
    return json({ ok:true, portfolio_id: pid, lots: lots.results||[] });
  })
  .add('POST','/portfolio/delete-lot', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const body:any = await req.json().catch(()=>({}));
    const lotId = body && typeof body.lot_id === 'string' ? body.lot_id : '';
    if (!lotId) return json({ ok:false, error:'lot_id_required' },400);
    const del = await env.DB.prepare(`DELETE FROM lots WHERE id=? AND portfolio_id=?`).bind(lotId, pid).run();
    const changes = (del as any).meta?.changes ?? 0;
    if (changes) await audit(env, { actor_type:'portfolio', actor_id:pid, action:'delete_lot', resource:'lot', resource_id:lotId });
    return json({ ok:true, deleted: changes });
  })
  .add('POST','/portfolio/update-lot', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const body:any = await req.json().catch(()=>({}));
    const lotId = typeof body.lot_id === 'string' ? body.lot_id : '';
    const qty = body.qty == null ? undefined : Number(body.qty);
    const cost = body.cost_usd == null ? undefined : Number(body.cost_usd);
    if (!lotId) return json({ ok:false, error:'lot_id_required' },400);
    if (qty !== undefined && (!Number.isFinite(qty) || qty <= 0)) return json({ ok:false, error:'invalid_qty' },400);
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return json({ ok:false, error:'invalid_cost' },400);
    const sets:string[] = []; const binds:any[] = [];
    if (qty !== undefined) { sets.push('qty=?'); binds.push(qty); }
    if (cost !== undefined) { sets.push('cost_usd=?'); binds.push(cost); }
    if (!sets.length) return json({ ok:false, error:'no_changes' },400);
    binds.push(lotId, pid);
    const res = await env.DB.prepare(`UPDATE lots SET ${sets.join(', ')} WHERE id=? AND portfolio_id=?`).bind(...binds).run();
    const changes = (res as any).meta?.changes ?? 0;
    if (changes) await audit(env, { actor_type:'portfolio', actor_id:pid, action:'update_lot', resource:'lot', resource_id:lotId, details:{ qty, cost_usd: cost } });
    return json({ ok:true, updated: changes });
  })
  // Factor exposure (latest)
  .add('GET','/portfolio/exposure', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const latest = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all();
    const d = (latest.results?.[0] as any)?.d;
    if (!d) return json({ ok:true, as_of:null, exposures:{} });
    const rs = await env.DB.prepare(`SELECT l.card_id,l.qty, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90 FROM lots l LEFT JOIN signal_components_daily sc ON sc.card_id=l.card_id AND sc.as_of=? WHERE l.portfolio_id=?`).bind(d, pid).all();
    const rows = (rs.results||[]) as any[]; let totalQty=0; const agg:Record<string,{w:number;sum:number}>={}; const factors=['ts7','ts30','z_svi','vol','liquidity','scarcity','mom90'];
    for (const r of rows){ const q=Number(r.qty)||0; if(q<=0) continue; totalQty+=q; for (const f of factors){ const v=Number((r as any)[f]); if(!Number.isFinite(v)) continue; const slot=agg[f]||(agg[f]={w:0,sum:0}); slot.w+=q; slot.sum+=v*q; } }
    const out:Record<string,number|null>={}; for (const f of factors){ const a=agg[f]; out[f]=a&&a.w>0? +(a.sum/a.w).toFixed(6): null; }
    return json({ ok:true, as_of:d, exposures: out });
  })
  // Scenario what-if exposures (does not persist) body: { lots:[{card_id, qty}], mode:'absolute'|'delta' }
  .add('POST','/portfolio/scenario', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const body:any = await req.json().catch(()=>({}));
    const mode = body && typeof body.mode === 'string' && (body.mode === 'delta' || body.mode === 'absolute') ? body.mode : 'absolute';
    const inputLots: any[] = Array.isArray(body?.lots) ? body.lots : [];
    // Load current lots
    const lotsRes = await env.DB.prepare(`SELECT card_id, qty FROM lots WHERE portfolio_id=?`).bind(pid).all();
    const currentLots = new Map<string, number>();
    for (const r of (lotsRes.results||[]) as any[]) currentLots.set(String(r.card_id), Number(r.qty)||0);
    const simulatedLots = new Map(currentLots);
    for (const l of inputLots) {
      if (!l || typeof l !== 'object') continue;
      const card_id = typeof l.card_id === 'string' ? l.card_id : '';
      const qty = Number(l.qty);
      if (!card_id || !Number.isFinite(qty) || qty < 0) continue;
      if (mode === 'delta') {
        const cur = simulatedLots.get(card_id)||0;
        const next = cur + qty;
        if (next <= 0) simulatedLots.delete(card_id); else simulatedLots.set(card_id, next);
      } else { // absolute
        if (qty === 0) simulatedLots.delete(card_id); else simulatedLots.set(card_id, qty);
      }
    }
    const latest = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all();
    const d = (latest.results?.[0] as any)?.d;
    // helper to compute exposures for a given lots map
    async function compute(map: Map<string,number>): Promise<Record<string,number|null>> {
      if (!d) return { ts7:null, ts30:null, z_svi:null, vol:null, liquidity:null, scarcity:null, mom90:null };
      if (!map.size) return { ts7:0, ts30:0, z_svi:0, vol:0, liquidity:0, scarcity:0, mom90:0 };
      const ids = Array.from(map.keys());
      const placeholders = ids.map(()=>'?').join(',');
      const rs = await env.DB.prepare(`SELECT card_id, ts7, ts30, z_svi, vol, liquidity, scarcity, mom90 FROM signal_components_daily WHERE as_of=? AND card_id IN (${placeholders})`).bind(d, ...ids).all();
      const factors=['ts7','ts30','z_svi','vol','liquidity','scarcity','mom90'];
      const agg:Record<string,{w:number;sum:number}>={};
      for (const r of (rs.results||[]) as any[]) {
        const q = map.get(String(r.card_id))||0; if (q<=0) continue;
        for (const f of factors) { const v = Number((r as any)[f]); if(!Number.isFinite(v)) continue; const slot=agg[f]||(agg[f]={w:0,sum:0}); slot.w+=q; slot.sum+=v*q; }
      }
      const out:Record<string,number|null>={};
      for (const f of factors) { const a=agg[f]; out[f]=a&&a.w>0? +(a.sum/a.w).toFixed(6): null; }
      return out;
    }
    const current_exposures = await compute(currentLots);
    const scenario_exposures = await compute(simulatedLots);
    const deltas:Record<string,number|null>={};
    for (const f of Object.keys(scenario_exposures)) {
      const a = scenario_exposures[f]; const b = current_exposures[f];
      if (a==null || b==null) deltas[f]= null; else deltas[f]= +((a as number)-(b as number)).toFixed(6);
    }
    return json({ ok:true, mode, as_of: d||null, current: current_exposures, scenario: scenario_exposures, deltas });
  })
  .add('GET','/portfolio/exposure/history', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const rs = await env.DB.prepare(`SELECT as_of, factor, exposure FROM portfolio_factor_exposure WHERE portfolio_id=? ORDER BY as_of DESC, factor ASC LIMIT 700`).bind(pid).all();
    return json({ ok:true, rows: rs.results||[] });
  })
  // Targets
  .add('GET','/portfolio/targets', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_targets (portfolio_id TEXT, kind TEXT, target_key TEXT, target_value REAL, created_at TEXT, PRIMARY KEY(portfolio_id, kind, target_key));`).run();
    const rs = await env.DB.prepare(`SELECT kind, target_key, target_value FROM portfolio_targets WHERE portfolio_id=? ORDER BY kind, target_key`).bind(pid).all();
    return json({ ok:true, rows: rs.results||[] });
  })
  .add('POST','/portfolio/targets', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const body:any = await req.json().catch(()=>({}));
    const parsed = validate(PortfolioTargetsSchema, body);
    if(!parsed.ok) return json({ ok:false, error:'invalid_body', details: parsed.errors },400);
    const factorTargets = parsed.data.factors || {};
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_targets (portfolio_id TEXT, kind TEXT, target_key TEXT, target_value REAL, created_at TEXT, PRIMARY KEY(portfolio_id, kind, target_key));`).run();
    let updated=0; for (const [k,v] of Object.entries(factorTargets)){ const val=Number(v); if(!Number.isFinite(val)) continue; await env.DB.prepare(`INSERT OR REPLACE INTO portfolio_targets (portfolio_id, kind, target_key, target_value, created_at) VALUES (?,?,?,?,datetime('now'))`).bind(pid,'factor',k,val).run(); updated++; }
    await audit(env, { actor_type:'portfolio', actor_id:pid, action:'set_targets', resource:'portfolio_targets', resource_id:pid, details:{ factors: updated } });
    return json({ ok:true, updated });
  })
  // Orders
  .add('POST','/portfolio/orders', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||'';
    const psec = req.headers.get('x-portfolio-secret')||'';
    const auth = await portfolioAuth(env, pid, psec);
    if (!auth.ok) return json({ ok:false, error:'forbidden' },403);
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_orders (id TEXT PRIMARY KEY, portfolio_id TEXT, created_at TEXT, status TEXT, objective TEXT, params TEXT, suggestions JSON, executed_at TEXT);`).run();
    const latest = await env.DB.prepare(`SELECT MAX(as_of) AS d FROM signal_components_daily`).all();
    const d = (latest.results?.[0] as any)?.d; let exposures:Record<string,number|null>={};
    if (d){ const rs = await env.DB.prepare(`SELECT l.qty, sc.ts7, sc.ts30, sc.z_svi, sc.vol, sc.liquidity, sc.scarcity, sc.mom90 FROM lots l LEFT JOIN signal_components_daily sc ON sc.card_id=l.card_id AND sc.as_of=? WHERE l.portfolio_id=?`).bind(d,pid).all(); const rows=(rs.results||[]) as any[]; const agg:Record<string,{w:number;sum:number}>={}; const factors=['ts7','ts30','z_svi','vol','liquidity','scarcity','mom90']; for(const r of rows){ const q=Number(r.qty)||0; if(q<=0) continue; for(const f of factors){ const v=Number((r as any)[f]); if(!Number.isFinite(v)) continue; const slot=agg[f]||(agg[f]={w:0,sum:0}); slot.w+=q; slot.sum+=v*q; }} for(const f of factors){ const a=agg[f]; exposures[f]=a&&a.w>0? +(a.sum/a.w).toFixed(6):0; }}
    const targetsRs = await env.DB.prepare(`SELECT target_key, target_value FROM portfolio_targets WHERE portfolio_id=? AND kind='factor'`).bind(pid).all();
    const targets:Record<string,number>={}; for(const r of (targetsRs.results||[]) as any[]) targets[r.target_key]=Number(r.target_value);
    const factor_deltas:Record<string,number>={}; for(const [k,tv] of Object.entries(targets)){ const cur=Number(exposures[k]??0); factor_deltas[k]=+(tv-cur).toFixed(6); }
    const suggestions={ factor_deltas, generated_at:new Date().toISOString(), trades: [] as any[] };
    const id=crypto.randomUUID(); const objective='align_targets';
    await env.DB.prepare(`INSERT INTO portfolio_orders (id, portfolio_id, created_at, status, objective, params, suggestions) VALUES (?,?,?,?,?,?,?)`).bind(id,pid,new Date().toISOString(),'open',objective,JSON.stringify({}),JSON.stringify(suggestions)).run();
    await audit(env, { actor_type:'portfolio', actor_id:pid, action:'create_order', resource:'portfolio_order', resource_id:id, details:{ objective, deltas:factor_deltas } });
    return json({ ok:true, id, objective, suggestions });
  })
  .add('GET','/portfolio/orders', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid = req.headers.get('x-portfolio-id')||''; const psec = req.headers.get('x-portfolio-secret')||''; const auth = await portfolioAuth(env, pid, psec); if(!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const rs = await env.DB.prepare(`SELECT id, created_at, status, objective, executed_at FROM portfolio_orders WHERE portfolio_id=? ORDER BY created_at DESC LIMIT 20`).bind(pid).all();
    return json({ ok:true, rows: rs.results||[] });
  })
  .add('POST','/portfolio/orders/execute', async ({ env, req }) => {
    await ensureTestSeed(env);
    const pid=req.headers.get('x-portfolio-id')||''; const psec=req.headers.get('x-portfolio-secret')||''; const auth=await portfolioAuth(env,pid,psec); if(!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const body:any = await req.json().catch(()=>({}));
    const parsed = validate(PortfolioOrderExecuteSchema, body);
    if(!parsed.ok) return json({ ok:false, error:'invalid_body', details: parsed.errors },400);
    const { id } = parsed.data;
    const orows = await env.DB.prepare(`SELECT id,status FROM portfolio_orders WHERE id=? AND portfolio_id=?`).bind(id,pid).all(); const order=(orows.results||[])[0] as any; if(!order) return json({ ok:false, error:'not_found' },404); if(order.status!=='open') return json({ ok:false, error:'invalid_status' },400);
    await env.DB.prepare(`UPDATE portfolio_orders SET status='executed', executed_at=datetime('now'), executed_trades=json('[]') WHERE id=?`).bind(id).run(); await audit(env,{ actor_type:'portfolio', actor_id:pid, action:'execute_order', resource:'portfolio_order', resource_id:id }); return json({ ok:true, id, status:'executed' });
  })
  .add('GET','/portfolio/orders/detail', async ({ env, req, url }) => {
    await ensureTestSeed(env);
    const pid=req.headers.get('x-portfolio-id')||''; const psec=req.headers.get('x-portfolio-secret')||''; const auth=await portfolioAuth(env,pid,psec); if(!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const id=(url.searchParams.get('id')||'').trim(); if(!id) return json({ ok:false, error:'id_required' },400);
    const rs=await env.DB.prepare(`SELECT id, created_at, status, objective, executed_at, suggestions, executed_trades FROM portfolio_orders WHERE id=? AND portfolio_id=?`).bind(id,pid).all(); const row:any=rs.results?.[0]; if(!row) return json({ ok:false, error:'not_found' },404);
    let suggestions:any=null, executed_trades:any=null; try{ if(row.suggestions) suggestions=JSON.parse(row.suggestions);}catch{} try{ if(row.executed_trades) executed_trades=JSON.parse(row.executed_trades);}catch{}
    return json({ ok:true, id: row.id, status: row.status, objective: row.objective, created_at: row.created_at, executed_at: row.executed_at, suggestions, executed_trades });
  })
  // Attribution & PnL
  .add('GET','/portfolio/attribution', async ({ env, req, url }) => {
    await ensureTestSeed(env);
    const pid=req.headers.get('x-portfolio-id')||''; const psec=req.headers.get('x-portfolio-secret')||''; const auth=await portfolioAuth(env,pid,psec); if(!auth.ok) return json({ ok:false, error:'forbidden' },403);
    const days=Math.min(180, Math.max(1, parseInt(url.searchParams.get('days')||'60',10))); const rows= await computePortfolioAttribution(env, pid, days); return json({ ok:true, rows });
  })
  .add('GET','/portfolio/pnl', async ({ env, req, url }) => {
    await ensureTestSeed(env);
    const pid=req.headers.get('x-portfolio-id')||''; const psec=req.headers.get('x-portfolio-secret')||''; const auth=await portfolioAuth(env,pid,psec); if(!auth.ok) return json({ ok:false, error:'forbidden' },403);
  const days=Math.min(180, Math.max(1, parseInt(url.searchParams.get('days')||'60',10))); const rs=await env.DB.prepare(`SELECT as_of, ret, turnover_cost, realized_pnl, benchmark_ret, alpha FROM portfolio_pnl WHERE portfolio_id=? ORDER BY as_of DESC LIMIT ?`).bind(pid, days).all(); return json({ ok:true, rows: rs.results||[] });
  });
}

registerPortfolioRoutes();
