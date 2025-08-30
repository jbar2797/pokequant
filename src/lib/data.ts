import { Env } from './types';
import { log } from './log';

export async function ensureTestSeed(env: Env) {
  try {
  // Always attempt idempotent core table creation (fast no-ops when present)
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, name TEXT, set_name TEXT, rarity TEXT, image_url TEXT, types TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS prices_daily (card_id TEXT, as_of DATE, price_usd REAL, price_eur REAL, src_updated_at TEXT, PRIMARY KEY(card_id, as_of));`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals_daily (card_id TEXT, as_of DATE, score REAL, signal TEXT, reasons TEXT, edge_z REAL, exp_ret REAL, exp_sd REAL, PRIMARY KEY(card_id, as_of));`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signal_components_daily (card_id TEXT, as_of DATE, ts7 REAL, ts30 REAL, dd REAL, vol REAL, z_svi REAL, regime_break INTEGER, liquidity REAL, scarcity REAL, mom90 REAL, PRIMARY KEY(card_id, as_of));`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mutation_audit (id TEXT PRIMARY KEY, ts TEXT, actor_type TEXT, actor_id TEXT, action TEXT, resource TEXT, resource_id TEXT, details TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolios (id TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT, secret_hash TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS lots (id TEXT PRIMARY KEY, portfolio_id TEXT, card_id TEXT, qty REAL, cost_usd REAL, acquired_at TEXT, note TEXT);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_orders (id TEXT PRIMARY KEY, portfolio_id TEXT, created_at TEXT, status TEXT, objective TEXT, params TEXT, suggestions JSON, executed_at TEXT, executed_trades JSON);`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS portfolio_targets (portfolio_id TEXT, kind TEXT, target_key TEXT, target_value REAL, created_at TEXT, PRIMARY KEY(portfolio_id, kind, target_key));`).run();
    try { await env.DB.prepare(`ALTER TABLE cards ADD COLUMN number TEXT`).run(); } catch {}
    try { await env.DB.prepare(`ALTER TABLE cards ADD COLUMN set_id TEXT`).run(); } catch {}
    try { await env.DB.prepare(`ALTER TABLE cards ADD COLUMN tcgplayer_url TEXT`).run(); } catch {}
    try { await env.DB.prepare(`ALTER TABLE cards ADD COLUMN cardmarket_url TEXT`).run(); } catch {}
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cards`).all().catch(()=>({ results: [{ n: 0 }] } as any));
    const n = Number(count.results?.[0]?.n) || 0;
    if (n === 0) {
      const today = new Date().toISOString().slice(0,10);
      await env.DB.prepare(`INSERT INTO cards (id,name,set_name,rarity,image_url,types,number,set_id) VALUES ('card1','Test Card','Test Set','Promo','https://placehold.co/160x223?text=PK','Fire','001','set1');`).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO prices_daily (card_id, as_of, price_usd, price_eur, src_updated_at) VALUES ('card1', ?, 12.34, 11.11, datetime('now'))`).bind(today).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO signals_daily (card_id, as_of, score, signal, reasons, edge_z, exp_ret, exp_sd) VALUES ('card1', ?, 1.5, 'BUY', 'test seed', 0.5, 0.02, 0.05)`).bind(today).run();
      try { await env.DB.prepare(`INSERT OR REPLACE INTO signal_components_daily (card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break) VALUES ('card1', ?, 0.1, 0.2, -0.05, 0.3, 1.2, 0)`).bind(today).run(); } catch {}
    }
  } catch {}
}

// Ensure the alerts_watch table (public price alerts) exists; minimal shape used by routes & alert runner.
export async function ensureAlertsTable(env: Env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS alerts_watch (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      card_id TEXT NOT NULL,
      kind TEXT DEFAULT 'price_below',
      threshold_usd REAL,
      active INTEGER DEFAULT 1,
      manage_token TEXT,
      created_at TEXT,
      last_fired_at TEXT,
      suppressed_until TEXT,
      fired_count INTEGER DEFAULT 0
    );`).run();
    // Legacy compatibility: if older 'threshold' column existed without threshold_usd, add & backfill handled by migrations; here just attempt adds for new columns.
    try { await env.DB.prepare(`ALTER TABLE alerts_watch ADD COLUMN suppressed_until TEXT`).run(); } catch {}
    try { await env.DB.prepare(`ALTER TABLE alerts_watch ADD COLUMN fired_count INTEGER DEFAULT 0`).run(); } catch {}
  } catch (e) { log('ensure_alerts_error', { error: String(e) }); }
}

// Determine which threshold column is present (threshold_usd preferred; legacy 'threshold').
export async function getAlertThresholdCol(env: Env): Promise<'threshold_usd'|'threshold'> {
  try {
    const rs = await env.DB.prepare(`PRAGMA table_info('alerts_watch')`).all();
    const cols = (rs.results||[]).map((r:any)=> (r.name||r.cid||'').toString());
    if (cols.includes('threshold_usd')) return 'threshold_usd';
    if (cols.includes('threshold')) return 'threshold';
  } catch {}
  return 'threshold_usd';
}
