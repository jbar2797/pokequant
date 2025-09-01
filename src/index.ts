// src/index.ts
// PokeQuant Worker — monolith (in-progress modularization). Factor & utility logic moved to ./lib/*.

// (legacy signal_math usage removed during modularization)
// import { compositeScore } from './signal_math';
// import { sendEmail, EMAIL_RETRY_MAX } from './email_adapter';
import { APP_VERSION, BUILD_COMMIT } from './version';
// (finalizeRequest & route helpers now unused here; public/admin routes modularized)
import { snapshotPortfolioFactorExposure } from './lib/portfolio_exposure';
import { detectAnomalies } from './lib/anomalies';
import { handleAdminSystem } from './routes/admin_system';
// import { z } from 'zod';
import { runMigrations, listMigrations } from './migrations';
// Modularized helpers
import type { Env } from './lib/types';
import { log, setRequestContext } from './lib/log';
import { json, err, CORS } from './lib/http';
import { isoDaysAgo } from './lib/date';
import { sha256Hex } from './lib/crypto';
import { rateLimit, getRateLimits } from './lib/rate_limit';
import { incMetric, incMetricBy, recordLatency, ensureMetricsSchema } from './lib/metrics';
import { audit } from './lib/audit';
import { portfolioAuth } from './lib/portfolio_auth';
import { getFactorUniverse, computeFactorReturns, computeFactorRiskModel, smoothFactorReturns, computeSignalQuality, computeFactorIC } from './lib/factors';
import { computeIntegritySnapshot, updateDataCompleteness } from './lib/integrity';
import { purgeOldData } from './lib/retention';
import { snapshotPortfolioNAV, computePortfolioPnL } from './lib/portfolio_nav';
import { ensureTestSeed } from './lib/data';
import { runIncrementalIngestion } from './lib/ingestion';
import { runAlerts } from './lib/alerts_run';
import { computeAndStoreSignals } from './lib/signals';
import { baseDataSignature } from './lib/base_data';
// Eagerly import all route modules at module load so the first request in CI does not spend
// significant time performing many dynamic imports under the test timeout clock. This mitigates
// observed GitHub Actions flakiness where coverage + cold bundling pushed initial request over 25s.
// (Each route module self-registers with the shared router instance.)
import './routes/factors';
import './routes/admin';
import './routes/anomalies';
import './routes/portfolio_nav';
import './routes/backfill';
import './routes/public';
import './routes/alerts';
import './routes/alerts_admin';
import './routes/backtests';
import './routes/webhooks';
import './routes/ingestion_schedule';
import './routes/audit';
import './routes/snapshot';
import './routes/metadata';
import './routes/search';
import './routes/subscribe';
import './routes/portfolio';
import './routes/explain';
import './routes/slo';
import './routes/admin_extras';
import './routes/test_helpers';
import { router } from './router';
let INDICES_DONE = false;
async function ensureIndices(env: Env) {
  if (INDICES_DONE) return;
  try {
    const tablesRes = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const names = new Set((tablesRes.results||[]).map((r:any)=> String(r.name)));
    const stmts: D1PreparedStatement[] = [];
    if (names.has('prices_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_prices_card_asof ON prices_daily(card_id, as_of);`));
    if (names.has('signals_daily')) {
      stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_card_asof ON signals_daily(card_id, as_of);`));
      stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_signals_asof ON signals_daily(as_of);`));
    }
    if (names.has('svi_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_svi_card_asof ON svi_daily(card_id, as_of);`));
    if (names.has('signal_components_daily')) stmts.push(env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_components_card_asof ON signal_components_daily(card_id, as_of);`));
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) {
    log('ensure_indices_error', { error: String(e) });
  }
  INDICES_DONE = true; // set regardless; safe if partial
}

// ---------- rate limiting (D1-backed fixed window) ----------
// rate limiting now in lib/rate_limit

// ---------- metrics (simple daily counter in D1) ----------
// metrics helpers now in lib/metrics

// ---------- mutation audit helper ----------
// Lightweight audit trail for state-changing endpoints. Best-effort (errors ignored).
// audit helper now in lib/audit


// ---------- universe fetch (lightweight local universe) ----------
// For now, derive universe from existing cards table; if empty seed will create some cards later.
async function fetchUniverse(env: Env) {
  try {
    const rs = await env.DB.prepare(`SELECT id FROM cards ORDER BY id ASC LIMIT 500`).all();
    return (rs.results||[]) as any[];
  } catch { return []; }
}


// ---------- Admin: fetch+upsert+compute (may hit limits if upstream is slow) ----------
async function pipelineRun(env: Env) {
  if ((env as any).FAST_TESTS === '1') {
    // Provide minimal shape without heavy external fetch or computations.
    return { ok:true, pricesForToday:0, signalsForToday:0, bulk:{ idsProcessed:0, wroteSignals:0 }, alerts:{ checked:0, fired:0 }, timingsMs:{ fetchUpsert:0, bulkCompute:0, alerts:0, total:0 } };
  }
  const t0 = Date.now();
  let universe: any[] = [];
  try { universe = await fetchUniverse(env); } catch (_e) {}
  // (bulk signal computation & alerts now handled via modular routes / cron) keep minimal placeholders
  const t1 = Date.now();
  const bulk = { idsProcessed: 0, wroteSignals: 0 };
  const t2 = Date.now();
  const alerts = { checked: 0, fired: 0 };
  const t3 = Date.now();
  await updateDataCompleteness(env); // record today's counts

  const today = new Date().toISOString().slice(0,10);
  const [prices, signals] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM prices_daily WHERE as_of=?`).bind(today).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM signals_daily WHERE as_of=?`).bind(today).all(),
  ]);

  return {
    ok: true,
    pricesForToday: prices.results?.[0]?.n ?? 0,
    signalsForToday: signals.results?.[0]?.n ?? 0,
  bulk,
  alerts,
    timingsMs: { fetchUpsert: t1-t0, bulkCompute: t2-t1, alerts: t3-t2, total: t3-t0 }
  };
}


// (anomaly detection moved to lib/anomalies.ts)


// Factor returns: compute top-bottom quintile forward return per enabled factor (using previous day factor values and forward price move)
// factor returns now in lib/factors

// ----- Factor risk model (covariance & correlation) + rolling vol/beta -----
// risk model now in lib/factors

// ----- Bayesian smoothing of factor returns (simple shrink to grand mean) -----
// smoothing now in lib/factors

// ----- Signal quality metrics (IC stability & half-life) -----
// signal quality now in lib/factors


// snapshotPortfolioFactorExposure now in lib/portfolio_exposure.ts


// ----- Stub email send for alerts (no external provider integrated) -----
async function sendEmailAlert(_env: Env, _to: string, _subject: string, _body: string) {
  // Placeholder – integrate provider (Resend) later. Logged only.
  log('email_stub', { to: _to, subject: _subject });
}

// factor universe helper removed (now imported from lib/factors)

// ----- Factor IC computation (rank IC prev-day factors vs forward return) -----
// factor IC now in lib/factors

// ----- Simple backtest: rank cards by latest composite score and form top-quintile vs bottom-quintile spread cumulative -----

// ---------- HTTP ----------
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const t0 = Date.now();
  // Correlation ID (reuse incoming or generate) and set request context for structured logs.
  const corrId = req.headers.get('x-request-id') || crypto.randomUUID();
  setRequestContext(corrId, env);
    // --- Fast init guard (prevents per-request full migration in parallel & avoids test timeouts) ---
    // Runs migrations exactly once with a timeout; concurrent requests wait or fast-fail 503 if timeout exceeded.
  let initError: string | null = null;
    // Module-scope singleflight vars
    // (Placed on globalThis to survive module reloads in dev worker)
    const g:any = globalThis as any;
    if (!g.__PQ_INIT_STATE) {
      g.__PQ_INIT_STATE = { done: false, promise: null as Promise<void>|null };
    }
    const state = g.__PQ_INIT_STATE as { done:boolean; promise: Promise<void>|null };
  // Propagate FAST_TESTS hint to migrations fast path (set once)
  if ((env as any).FAST_TESTS === '1') { (globalThis as any).__FAST_TESTS = '1'; }
  async function initializeOnce() {
      if (state.done) return;
      if (!state.promise) {
        state.promise = (async () => {
          const tInit0 = Date.now();
          try {
      await runMigrations(env.DB, { fast: (env as any).FAST_TESTS === '1' });
            // Ensure metrics table exists early to avoid first-request race before first metric increment
            try { await env.DB.prepare(`CREATE TABLE IF NOT EXISTS metrics_daily (d TEXT, metric TEXT, count INTEGER, PRIMARY KEY(d,metric));`).run(); } catch {}
            state.done = true;
            await incMetric(env, 'init.success');
            await recordLatency(env, 'lat.init', Date.now()-tInit0);
            log('init_ok', { ms: Date.now()-tInit0 });
          } catch (e:any) {
            initError = String(e);
            await incMetric(env, 'init.error');
            log('init_error', { error: initError });
            throw e;
          } finally {
            // Allow GC of promise on success; keep failed promise so subsequent awaits fail fast.
            if (state.done) state.promise = null;
          }
        })();
      }
      return state.promise;
    }
    if (!state.done) {
      try { await initializeOnce(); } catch { return new Response('Initialization failed', { status: 500, headers: CORS }); }
    }
  // Extra guard: ensure metrics schema (cheap) before routing so latency + counters don't emit missing-table errors during high parallel test startup.
  try { await ensureMetricsSchema(env); } catch {/* ignore */}
    // Removed unconditional per-request runMigrations to reduce contention & CI timeouts. Admin endpoint /admin/migrations still verifies.
    // Lightweight safeguard: if this specific D1 instance hasn't run migrations yet (rotated between tests), run them now (singleflight inside runMigrations).
    try {
      const anyDb: any = env.DB as any;
      if (!anyDb.__MIGRATIONS_DONE) {
        await runMigrations(env.DB, { fast: (env as any).FAST_TESTS === '1' });
      }
      else {
        // Integrity re-check: underlying storage may rotate while keeping same DB object; verify core tables exist.
        try {
          const core = ['cards','signals_daily','factor_returns'];
          const rs = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cards','signals_daily','factor_returns')`).all();
          const present = new Set((rs.results||[]).map((r:any)=> String(r.name)));
          let missing = false; for (const t of core) if (!present.has(t)) { missing = true; break; }
          if (missing) {
            (anyDb.__MIGRATIONS_DONE = false); // force rerun
            await runMigrations(env.DB, { fast: (env as any).FAST_TESTS === '1' });
          }
        } catch {/* ignore */}
      }
    } catch { /* swallow */ }
    // Router dispatch (routes already eagerly registered at module load)
    try {
      const routed = await router.handle(req, env);
      if (routed) return routed;
    } catch (e) { try { console.warn('router dispatch failed', e); } catch {} }
    // Per-request evaluation (env differs by environment / binding)
    (globalThis as any).__LOG_DISABLED = (env.LOG_ENABLED === '0');
  // Fire-and-forget (don't await) except for endpoints known to immediately query large tables.
    const pathname = url.pathname;
    const critical = pathname.startsWith('/api/cards') || pathname.startsWith('/api/movers') || pathname.startsWith('/api/search');
  // Always await indices to avoid background writes that can trip isolated storage assertions in tests
  await ensureIndices(env);
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // (Migrations already ensured at top.)

  // Public routes (/health, /api/universe, /api/cards, /api/movers, /api/card) now fully handled in routes/public.ts via router.

    // CSV export

  // --- Portfolio endpoints moved to routes/portfolio.ts ---
  // (admin/alert-queue/send handled in routes/alerts_admin.ts)

    // Ingest Trends (GitHub Action)

    // ---- Admin: diagnostics & runs ----

  // (admin metrics / latency / latency-buckets / metrics-export / webhooks / email deliveries now in routes/admin.ts & routes/webhooks.ts)

    // Admin test utility: force legacy portfolio auth by nulling secret_hash for a portfolio id

    // Data integrity snapshot (coverage + staleness + gap heuristic)
    if (url.pathname === '/admin/integrity' && req.method === 'GET') {
      { const at=req.headers.get('x-admin-token'); if(!(at&&(at===env.ADMIN_TOKEN||(env.ADMIN_TOKEN_NEXT&&at===env.ADMIN_TOKEN_NEXT)))) return json({ ok:false, error:'forbidden' }, 403); }
      try {
  const integrity = await computeIntegritySnapshot(env);
  return json(integrity);
      } catch (e:any) {
        return json({ ok:false, error:String(e) }, 500);
      }
    }

    // Phase 1 modularized admin system routes (extracted)
    {
      const adminResp = await handleAdminSystem(req, env, url);
      if (adminResp) return adminResp;
    }

  // (Legacy admin retention/migrations/version/pipeline-runs/factors/test-insert now handled via routes/admin_system.ts)

  // (Factor weights CRUD endpoints removed in favor of routes/factors.ts)

    // Run alerts only (for tests / manual)

  // (factor IC, summary, returns endpoints removed; now provided by routes/factors.ts)
  // (factor risk, metrics, returns-smoothed endpoints removed; handled by routes/factors.ts)
  // (signal-quality, factor-performance endpoints removed; provided by routes/factors.ts)
  // (Factors CRUD now handled in routes/admin_system.ts)

    // Ingestion schedule config
    // Admin: list alerts with filters
  // (admin/alerts & /admin/alerts/stats handled in routes/alerts_admin.ts)

    // Run backtest

    // Snapshot endpoint (metadata bundle)

    // Test seed utility (not documented) to insert cards & prices
    if (url.pathname === '/admin/test-seed' && req.method === 'POST') {
      { const at=req.headers.get('x-admin-token'); if(!(at&&(at===env.ADMIN_TOKEN||(env.ADMIN_TOKEN_NEXT&&at===env.ADMIN_TOKEN_NEXT)))) return json({ ok:false, error:'forbidden' },403); }
      const body: any = await req.json().catch(()=>({}));
      const cards = Array.isArray(body.cards) ? body.cards : [];
      const batch: D1PreparedStatement[] = [];
  // Ensure tables
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, rarity TEXT, image_url TEXT, types TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id,as_of));`).run();
      for (const c of cards) {
        if (!c.id) continue;
        batch.push(env.DB.prepare(`INSERT OR REPLACE INTO cards (id,name,set_name,rarity,image_url,types) VALUES (?,?,?,?,?,?)`).bind(c.id, c.name||c.id, c.set_name||null, c.rarity||null, null, null));
        if (c.price_usd !== undefined) {
          const as_of = (c.as_of && /^\d{4}-\d{2}-\d{2}$/.test(c.as_of)) ? c.as_of : new Date().toISOString().slice(0,10);
          batch.push(env.DB.prepare(`INSERT OR REPLACE INTO prices_daily (card_id, as_of, price_usd) VALUES (?,?,?)`).bind(c.id, as_of, c.price_usd));
        }
      }
      if (batch.length) await env.DB.batch(batch);
      return json({ ok:true, inserted: cards.length });
    }

    // NEW: fast, bulk compute only (safe warm)

    // Full pipeline (may hit subrequest caps if upstream is slow)

    // Audit log listing endpoint

    // Factor correlations (admin) based on factor_returns rolling window

    // Root
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('PokeQuant API is running. See /api/cards', { headers: CORS });
    }

  // Fallback 404
  log('http_404', { path: url.pathname, method: req.method });
  return new Response('Not found', { status: 404, headers: CORS });
  },

  async scheduled(_ev: ScheduledEvent, env: Env) {
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, status TEXT, error TEXT, metrics JSON);`).run();
      const overlapping = await env.DB.prepare(`SELECT id FROM pipeline_runs WHERE status='running' AND started_at >= datetime('now','-30 minutes') LIMIT 1`).all();
      if ((overlapping.results||[]).length) { incMetric(env, 'pipeline.skip_overlap'); return; }
      const runId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO pipeline_runs (id, started_at, status) VALUES (?,?, 'running')`).bind(runId, new Date().toISOString()).run();
      const phases: { name:string; fn:()=>Promise<any> }[] = [
        { name:'signals', fn: ()=> computeAndStoreSignals(env, { limit: 500 }) },
        { name:'alerts', fn: ()=> runAlerts(env) },
        { name:'data_completeness', fn: ()=> updateDataCompleteness(env) },
        { name:'factor_ic', fn: ()=> computeFactorIC(env) },
        { name:'factor_returns', fn: ()=> computeFactorReturns(env) },
        { name:'risk_model', fn: ()=> computeFactorRiskModel(env) },
        { name:'returns_smoothed', fn: ()=> smoothFactorReturns(env) },
        { name:'signal_quality', fn: ()=> computeSignalQuality(env) },
        { name:'anomalies', fn: ()=> detectAnomalies(env) },
        { name:'portfolio_nav', fn: ()=> snapshotPortfolioNAV(env) },
        { name:'portfolio_pnl', fn: ()=> computePortfolioPnL(env) },
        { name:'portfolio_factor_exposure', fn: ()=> snapshotPortfolioFactorExposure(env) },
        { name:'retention', fn: async ()=> { const t0r=Date.now(); const deleted=await purgeOldData(env); const rMs=Date.now()-t0r; for (const [table,n] of Object.entries(deleted)) if (n>0) incMetricBy(env, `retention.deleted.${table}`, n); recordLatency(env,'job.retention', rMs); return { deleted }; } }
      ];
      const metrics: any = { phases:{} };
      try {
        for (const p of phases) { const t=Date.now(); try { const out=await p.fn(); metrics.phases[p.name]={ ms: Date.now()-t }; if (out && out.deleted) metrics.deleted = out.deleted; } catch (e:any){ metrics.phases[p.name]={ ms: Date.now()-t, error:String(e) }; throw e; } }
        await env.DB.prepare(`UPDATE pipeline_runs SET completed_at=?, status='completed', metrics=? WHERE id=?`).bind(new Date().toISOString(), JSON.stringify(metrics), runId).run();
      } catch (e:any) {
        await env.DB.prepare(`UPDATE pipeline_runs SET completed_at=?, status='error', error=?, metrics=? WHERE id=?`).bind(new Date().toISOString(), String(e), JSON.stringify(metrics), runId).run();
        incMetric(env, 'pipeline.error');
      }
    } catch (e) { log('cron_error', { error:String(e) }); }
  }
};

