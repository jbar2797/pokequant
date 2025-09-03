// Lightweight hook to emit metrics without importing the whole metrics module here (avoid cycles).
type MetricFn = (name: string) => Promise<any> | void;
let metricFn: MetricFn | undefined;
export function registerBreakerMetricEmitter(fn: MetricFn){ metricFn = fn; }
// Simple in-memory circuit breaker keyed by host/provider.
// Open after failure ratio threshold within recent window; half-open after timeout.

interface BreakerState { fails: number; total: number; opened_at?: number; state: 'closed'|'open'|'half'; next_attempt_after?: number; consecutive_failures: number; }
const breakers: Record<string, BreakerState> = Object.create(null);
// Persistence throttle bookkeeping (per-key last persist ms)
const lastPersist: Record<string, number> = Object.create(null);
let persistenceEnabled = true; // allow tests to disable if needed
export function _disableBreakerPersistence(){ persistenceEnabled = false; }

export interface BreakerOptions { windowSize?: number; failRatio?: number; minSamples?: number; openMs?: number; }
const DEFAULTS: Required<BreakerOptions> = { windowSize: 20, failRatio: 0.5, minSamples: 5, openMs: 30_000 };

export function beforeCall(key: string, opts?: BreakerOptions): { allow: boolean; state: string; } {
  const st = breakers[key];
  if (!st) return { allow: true, state: 'closed' };
  if (st.state === 'open') {
    if (st.opened_at && Date.now() >= st.opened_at + (opts?.openMs || DEFAULTS.openMs)) {
      // Transition to half-open and allow a probe
      st.state = 'half';
      return { allow: true, state: 'half' };
    }
    return { allow: false, state: 'open' };
  }
  return { allow: true, state: st.state };
}

export function afterCall(key: string, ok: boolean, opts?: BreakerOptions, env?: any) {
  const cfg = { ...DEFAULTS, ...(opts||{}) };
  let st = breakers[key];
  if (!st) { st = breakers[key] = { fails:0, total:0, state:'closed', consecutive_failures:0 }; }
  st.total++; if (!ok) { st.fails++; st.consecutive_failures++; } else { st.consecutive_failures=0; }
  // Trim window by probabilistic decay (simple)
  if (st.total > cfg.windowSize) { st.total = Math.ceil(st.total*0.9); st.fails = Math.min(st.fails, st.total); }
  const ratio = st.total ? st.fails / st.total : 0;
  let transitioned = false;
  if (st.state === 'closed' && st.total >= cfg.minSamples && ratio >= cfg.failRatio) {
    st.state = 'open'; st.opened_at = Date.now(); transitioned = true; if (metricFn) metricFn('breaker.open');
  } else if (st.state === 'half') {
    if (!ok) { st.state = 'open'; st.opened_at = Date.now(); transitioned = true; if(metricFn) metricFn('breaker.reopen'); }
    else { st.state='closed'; st.fails=0; st.total=0; transitioned = true; if(metricFn) metricFn('breaker.close'); }
  }
  // Persist (best-effort) on state transition or periodic (every 10 ops & >=5s since last persist)
  if (env && persistenceEnabled) {
    try {
      if (transitioned || (st.total % 10 === 0 && Date.now() - (lastPersist[key]||0) > 5000)) {
        persistOne(env, key, st);
        lastPersist[key] = Date.now();
      }
    } catch {/* ignore persistence errors */}
  }
}

export function breakerSnapshot() { return Object.entries(breakers).map(([k,v])=> ({ key:k, ...v })); }

// --- Persistence helpers ---
async function persistOne(env:any, key:string, st: BreakerState) {
  if(!env || !env.DB) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS circuit_breaker_state (key TEXT PRIMARY KEY, state TEXT, fails INTEGER, total INTEGER, consecutive_failures INTEGER, opened_at INTEGER, updated_at TEXT);`).run();
    await env.DB.prepare(`INSERT INTO circuit_breaker_state (key,state,fails,total,consecutive_failures,opened_at,updated_at) VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET state=excluded.state, fails=excluded.fails, total=excluded.total, consecutive_failures=excluded.consecutive_failures, opened_at=excluded.opened_at, updated_at=datetime('now')`).bind(key, st.state, st.fails, st.total, st.consecutive_failures, st.opened_at||null).run();
  } catch {/* ignore */}
}

export async function hydrateBreakers(env:any){
  if(!env || !env.DB) return;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS circuit_breaker_state (key TEXT PRIMARY KEY, state TEXT, fails INTEGER, total INTEGER, consecutive_failures INTEGER, opened_at INTEGER, updated_at TEXT);`).run();
    const rs = await env.DB.prepare(`SELECT key,state,fails,total,consecutive_failures,opened_at FROM circuit_breaker_state`).all();
    for(const r of (rs.results||[]) as any[]){
      const key = String((r as any).key);
      if(!key) continue;
      breakers[key] = {
        state: (r as any).state || 'closed',
        fails: Number((r as any).fails)||0,
        total: Number((r as any).total)||0,
        consecutive_failures: Number((r as any).consecutive_failures)||0,
        opened_at: (r as any).opened_at ? Number((r as any).opened_at) : undefined,
        next_attempt_after: undefined
      };
    }
  } catch {/* ignore hydrate errors */}
}
