// Simple in-process migration runner for D1.
// Migrations are id + SQL (single statement or multiple separated by ;).
// They are applied exactly once and recorded in migrations_applied.

export interface Migration { id: string; sql: string; description?: string }

// Baseline migration (no-op placeholders) — ensures tracking table exists.
export const migrations: Migration[] = [
  {
    id: '0001_baseline',
    description: 'Baseline schema tracking row (existing tables created lazily elsewhere)',
    sql: '-- baseline no-op' 
  },
  {
    id: '0003_indices',
    description: 'Create performance and alert indices',
    sql: `CREATE INDEX IF NOT EXISTS idx_prices_card_asof ON prices_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_signals_card_asof ON signals_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_signals_asof ON signals_daily(as_of);
CREATE INDEX IF NOT EXISTS idx_svi_card_asof ON svi_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_components_card_asof ON signal_components_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_lots_card ON lots(card_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active_card ON alerts_watch(active, card_id);
CREATE INDEX IF NOT EXISTS idx_alerts_email ON alerts_watch(email);`
  },
  {
    id: '0004_metrics_latency_view',
    description: 'Add convenience view for latency metrics (decoding *1000 stored values)',
    sql: `CREATE VIEW IF NOT EXISTS metrics_latency AS
SELECT d,
       REPLACE(REPLACE(metric,'.p50',''),'.p95','') AS base_metric,
       MAX(CASE WHEN metric LIKE '%.p50' THEN count/1000.0 END) AS p50_ms,
       MAX(CASE WHEN metric LIKE '%.p95' THEN count/1000.0 END) AS p95_ms
FROM metrics_daily
WHERE metric LIKE 'lat.%'
GROUP BY d, base_metric;`
  },
  {
    id: '0005_alert_threshold_normalize',
    description: 'Add threshold_usd column if missing and backfill from legacy threshold',
    sql: `-- Normalize alert threshold column\nALTER TABLE alerts_watch ADD COLUMN threshold_usd REAL;\nUPDATE alerts_watch SET threshold_usd = threshold WHERE threshold_usd IS NULL AND threshold IS NOT NULL;`
  },
  {
    id: '0002_core_tables',
    description: 'Create core tables so health/check endpoints do not error on fresh DB',
    sql: `CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  name TEXT,
  set_id TEXT,
  set_name TEXT,
  number TEXT,
  rarity TEXT,
  image_url TEXT,
  tcgplayer_url TEXT,
  cardmarket_url TEXT,
  types TEXT
);
CREATE TABLE IF NOT EXISTS prices_daily (
  card_id TEXT,
  as_of DATE,
  price_usd REAL,
  price_eur REAL,
  src_updated_at TEXT,
  PRIMARY KEY(card_id, as_of)
);
CREATE TABLE IF NOT EXISTS svi_daily (
  card_id TEXT,
  as_of DATE,
  svi INTEGER,
  PRIMARY KEY(card_id, as_of)
);
CREATE TABLE IF NOT EXISTS signals_daily (
  card_id TEXT,
  as_of DATE,
  score REAL,
  signal TEXT,
  reasons TEXT,
  edge_z REAL,
  exp_ret REAL,
  exp_sd REAL,
  PRIMARY KEY(card_id, as_of)
);
CREATE TABLE IF NOT EXISTS signal_components_daily (
  card_id TEXT,
  as_of DATE,
  ts7 REAL,
  ts30 REAL,
  dd REAL,
  vol REAL,
  z_svi REAL,
  regime_break INTEGER,
  PRIMARY KEY(card_id, as_of)
);
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT,
  card_id TEXT,
  qty REAL,
  cost_usd REAL,
  acquired_at TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS alerts_watch (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  threshold_usd REAL,
  created_at TEXT,
  last_fired_at TEXT,
  active INTEGER DEFAULT 1,
  manage_token TEXT
);
` }
  ,
  {
    id: '0006_data_completeness',
    description: 'Add data_completeness ledger table for per-dataset per-day row counts',
    sql: `CREATE TABLE IF NOT EXISTS data_completeness (
  dataset TEXT NOT NULL,
  as_of DATE NOT NULL,
  rows INTEGER NOT NULL,
  PRIMARY KEY(dataset, as_of)
);`
  }
  ,
  {
    id: '0007_factor_weights',
    description: 'Add factor_weights table for dynamic composite weighting',
    sql: `CREATE TABLE IF NOT EXISTS factor_weights (
  version TEXT NOT NULL,
  factor TEXT NOT NULL,
  weight REAL NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT,
  PRIMARY KEY(version, factor)
);`
  }
  ,
  {
    id: '0008_backtests',
    description: 'Add backtests table for strategy evaluation storage',
    sql: `CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  params TEXT,
  metrics JSON,
  equity_curve JSON
);`
  }
  ,
  {
    id: '0009_factor_ic',
    description: 'Add factor_ic table to store daily information coefficients per factor',
    sql: `CREATE TABLE IF NOT EXISTS factor_ic (
  as_of DATE NOT NULL,
  factor TEXT NOT NULL,
  ic REAL,
  PRIMARY KEY(as_of, factor)
);`
  }
];

let MIGRATIONS_RAN = false;
let MIGRATIONS_PROMISE: Promise<void> | null = null;

export async function runMigrations(db: D1Database) {
  if (MIGRATIONS_RAN) return;
  if (MIGRATIONS_PROMISE) return MIGRATIONS_PROMISE;
  MIGRATIONS_PROMISE = (async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS migrations_applied (id TEXT PRIMARY KEY, applied_at TEXT, description TEXT);`).run();
    const existing = await db.prepare(`SELECT id FROM migrations_applied`).all();
    const have = new Set((existing.results||[]).map((r:any)=> String(r.id)));
    for (const m of migrations) {
      if (have.has(m.id)) continue;
      if (m.sql.trim() && !/^--/.test(m.sql.trim())) {
        const parts = m.sql.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean);
        for (const p of parts) {
          try {
            if (!p) continue;
            await db.prepare(p).run();
          } catch (e:any) {
            // Ignore missing table errors for indices (will be created lazily later)
            const msg = String(e);
            if (!/no such table/i.test(msg) && !/duplicate column name/i.test(msg)) {
              // Re-throw for other errors
              throw e;
            }
          }
        }
      }
      await db.prepare(`INSERT INTO migrations_applied (id, applied_at, description) VALUES (?,?,?)`).bind(m.id, new Date().toISOString(), m.description||null).run();
    }
    MIGRATIONS_RAN = true;
  })();
  return MIGRATIONS_PROMISE;
}

export async function listMigrations(db: D1Database) {
  try {
    const rs = await db.prepare(`SELECT id, applied_at, description FROM migrations_applied ORDER BY id ASC`).all();
    return rs.results || [];
  } catch {
    return [];
  }
}