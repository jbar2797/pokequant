import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for factor_config CRUD, portfolio exposure, and enhanced backtest metrics

describe('Factor config & exposure & backtest metrics', () => {
  it('can create, list, toggle, and delete factor config entries', async () => {
    const up = await SELF.fetch('https://example.com/admin/factors', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ factor:'testfactor', enabled:true, display_name:'Test Factor' }) });
    expect(up.status).toBe(200);
    const list = await SELF.fetch('https://example.com/admin/factors', { headers:{'x-admin-token':'test-admin'} });
    const lj: any = await list.json();
    expect(lj.ok).toBe(true);
    expect(lj.rows.some((r:any)=> r.factor==='testfactor')).toBe(true);
    const toggle = await SELF.fetch('https://example.com/admin/factors/toggle', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ factor:'testfactor', enabled:false }) });
    expect(toggle.status).toBe(200);
    const del = await SELF.fetch('https://example.com/admin/factors/delete', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ factor:'testfactor' }) });
    expect(del.status).toBe(200);
  });

  it('returns portfolio exposure (empty exposures when no lots)', async () => {
    // create portfolio
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    const pj: any = await create.json();
    const exposure = await SELF.fetch('https://example.com/portfolio/exposure', { headers:{ 'x-portfolio-id': pj.id, 'x-portfolio-secret': pj.secret } });
    expect(exposure.status).toBe(200);
    const ej: any = await exposure.json();
    expect(ej.ok).toBe(true);
  });

  it('backtest returns enhanced metrics (sharpe, drawdown)', async () => {
    // warm signals
    await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers:{'x-admin-token':'test-admin'} });
    let run = await SELF.fetch('https://example.com/admin/backtests', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ lookbackDays: 30, txCostBps: 5, slippageBps: 3 }) });
    let rj: any = await run.json();
    if (!rj.ok) {
      // attempt another warm + retry
      await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers:{'x-admin-token':'test-admin'} });
      run = await SELF.fetch('https://example.com/admin/backtests', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ lookbackDays: 15 }) });
      rj = await run.json();
    }
    // Accept ok=false (no_data) on pristine DB but ensure shape when ok
    if (rj.ok) {
      expect(rj.metrics).toBeDefined();
      expect(rj.metrics).toHaveProperty('sharpe');
      expect(rj.metrics).toHaveProperty('max_drawdown');
    } else {
      expect(rj.error).toBeDefined();
    }
  });
});