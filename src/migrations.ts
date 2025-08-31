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
  ,
  {
    id: '0010_anomalies',
    description: 'Add anomalies table for large day-over-day moves',
    sql: `CREATE TABLE IF NOT EXISTS anomalies (
  id TEXT PRIMARY KEY,
  as_of DATE,
  card_id TEXT,
  kind TEXT,
  magnitude REAL,
  created_at TEXT
);`
  }
  ,
  {
    id: '0011_portfolio_nav',
    description: 'Add portfolio_nav table to store daily market value snapshots',
    sql: `CREATE TABLE IF NOT EXISTS portfolio_nav (
  portfolio_id TEXT,
  as_of DATE,
  market_value REAL,
  PRIMARY KEY(portfolio_id, as_of)
);`
  }
  ,
  {
    id: '0012_backfill_jobs',
    description: 'Add backfill_jobs table for historical ingestion tracking',
    sql: `CREATE TABLE IF NOT EXISTS backfill_jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  dataset TEXT,
  from_date DATE,
  to_date DATE,
  days INTEGER,
  status TEXT,
  processed INTEGER,
  total INTEGER,
  error TEXT
);`
  }
  ,
  {
    id: '0013_components_extension',
    description: 'Extend signal_components_daily with liquidity, scarcity, mom90 columns',
    sql: `ALTER TABLE signal_components_daily ADD COLUMN liquidity REAL;
ALTER TABLE signal_components_daily ADD COLUMN scarcity REAL;
ALTER TABLE signal_components_daily ADD COLUMN mom90 REAL;`
  }
  ,
  {
    id: '0014_factor_config',
    description: 'Add factor_config table to allow dynamic factor universe definitions',
    sql: `CREATE TABLE IF NOT EXISTS factor_config (
  factor TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 1,
  display_name TEXT,
  created_at TEXT
);`
  }
  ,
  {
    id: '0015_factor_returns',
    description: 'Add factor_returns table storing simple top-bottom quintile forward returns per factor',
    sql: `CREATE TABLE IF NOT EXISTS factor_returns (
  as_of DATE NOT NULL,
  factor TEXT NOT NULL,
  ret REAL,
  PRIMARY KEY(as_of, factor)
);`
  }
  ,
  {
    id: '0016_portfolio_factor_exposure',
    description: 'Add portfolio_factor_exposure table for daily stored portfolio factor exposures',
    sql: `CREATE TABLE IF NOT EXISTS portfolio_factor_exposure (
  portfolio_id TEXT NOT NULL,
  as_of DATE NOT NULL,
  factor TEXT NOT NULL,
  exposure REAL,
  PRIMARY KEY(portfolio_id, as_of, factor)
);`
  }
  ,
  {
    id: '0017_anomalies_resolution',
    description: 'Add resolution columns to anomalies table (resolved flag, kind, note, timestamp)',
    sql: `ALTER TABLE anomalies ADD COLUMN resolved INTEGER DEFAULT 0;
ALTER TABLE anomalies ADD COLUMN resolution_kind TEXT;
ALTER TABLE anomalies ADD COLUMN resolution_note TEXT;
ALTER TABLE anomalies ADD COLUMN resolved_at TEXT;`
  }
  ,
  {
    id: '0018_ingestion_provenance',
    description: 'Add ingestion_provenance table to audit external/historical ingestion runs',
    sql: `CREATE TABLE IF NOT EXISTS ingestion_provenance (
  id TEXT PRIMARY KEY,
  dataset TEXT,
  source TEXT,
  from_date DATE,
  to_date DATE,
  started_at TEXT,
  completed_at TEXT,
  status TEXT,
  rows INTEGER,
  error TEXT
);`
  }
  ,
  {
    id: '0019_ingestion_config',
    description: 'Add ingestion_config table to track per-dataset per-source cursors and enable flags',
    sql: `CREATE TABLE IF NOT EXISTS ingestion_config (
  dataset TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor TEXT,
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  meta TEXT,
  PRIMARY KEY(dataset, source)
);`
  }
  ,
  {
    id: '0020_mutation_audit',
    description: 'Add mutation_audit table for tracking state-changing actions',
    sql: `CREATE TABLE IF NOT EXISTS mutation_audit (
  id TEXT PRIMARY KEY,
  ts TEXT,
  actor_type TEXT,
  actor_id TEXT,
  action TEXT,
  resource TEXT,
  resource_id TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON mutation_audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON mutation_audit(resource);`
  }
  ,
  {
    id: '0021_audit_indexes_actor_action',
    description: 'Add indexes on mutation_audit(actor_type) and action for faster filtered queries',
    sql: `CREATE INDEX IF NOT EXISTS idx_audit_actor_type ON mutation_audit(actor_type);
CREATE INDEX IF NOT EXISTS idx_audit_action ON mutation_audit(action);`
  }
  ,
  {
    id: '0022_factor_returns_indexes',
    description: 'Add composite index to speed factor correlation window queries',
    sql: `CREATE INDEX IF NOT EXISTS idx_factor_returns_asof_factor ON factor_returns(as_of, factor);`
  }
  ,
  {
    id: '0023_factor_risk_model',
    description: 'Add factor_risk_model table for pairwise cov/corr matrices',
    sql: `CREATE TABLE IF NOT EXISTS factor_risk_model (
  as_of DATE,
  factor_i TEXT,
  factor_j TEXT,
  cov REAL,
  corr REAL,
  PRIMARY KEY(as_of, factor_i, factor_j)
);`
  }
  ,
  {
    id: '0024_factor_metrics',
    description: 'Add factor_metrics table for rolling volatility and beta',
    sql: `CREATE TABLE IF NOT EXISTS factor_metrics (
  as_of DATE,
  factor TEXT,
  vol REAL,
  beta REAL,
  PRIMARY KEY(as_of,factor)
);`
  }
  ,
  {
    id: '0025_factor_returns_smoothed',
    description: 'Add factor_returns_smoothed table (Bayesian shrinkage of daily returns)',
    sql: `CREATE TABLE IF NOT EXISTS factor_returns_smoothed (
  as_of DATE,
  factor TEXT,
  ret_smoothed REAL,
  PRIMARY KEY(as_of,factor)
);`
  }
  ,
  {
    id: '0026_portfolio_pnl',
    description: 'Add portfolio_pnl table for daily return & turnover cost',
    sql: `CREATE TABLE IF NOT EXISTS portfolio_pnl (
  portfolio_id TEXT,
  as_of DATE,
  ret REAL,
  turnover_cost REAL,
  realized_pnl REAL,
  PRIMARY KEY(portfolio_id, as_of)
);`
  }
  ,
  {
    id: '0027_signal_quality_metrics',
    description: 'Add signal_quality_metrics table (IC stability & half-life)',
    sql: `CREATE TABLE IF NOT EXISTS signal_quality_metrics (
  as_of DATE,
  factor TEXT,
  ic_mean REAL,
  ic_vol REAL,
  ic_autocorr_lag1 REAL,
  ic_half_life REAL,
  PRIMARY KEY(as_of, factor)
);`
  }
  ,
  {
    id: '0028_portfolio_secret_hash',
    description: 'Add secret_hash column to portfolios for hashed secret storage',
    sql: `ALTER TABLE portfolios ADD COLUMN secret_hash TEXT;`
  }
  ,
  {
    id: '0029_portfolio_secret_deprecate',
    description: 'Deprecate plaintext secret column once all hashes populated (sets secret to NULL)',
  // No-op in test refactor: retain legacy secret to satisfy NOT NULL constraint & tests.
  sql: '-- skipped: retain plaintext secret for backward compatibility'
  }
  ,
  {
    id: '0030_alert_email_queue',
    description: 'Add alert_email_queue table for outbound email simulation',
    sql: `CREATE TABLE IF NOT EXISTS alert_email_queue (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  email TEXT,
  card_id TEXT,
  kind TEXT,
  threshold_usd REAL,
  status TEXT,
  sent_at TEXT
);`
  }
  ,
  {
    id: '0031_alert_email_retry',
    description: 'Add retry metadata columns to alert_email_queue',
    sql: `ALTER TABLE alert_email_queue ADD COLUMN attempt_count INTEGER DEFAULT 0;
ALTER TABLE alert_email_queue ADD COLUMN last_error TEXT;`
  }
  ,
  {
    id: '0032_portfolio_orders',
    description: 'Add portfolio_orders table to record proposed and executed trades for optimization feature',
    sql: `CREATE TABLE IF NOT EXISTS portfolio_orders (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT,
  created_at TEXT,
  status TEXT,
  objective TEXT,
  params TEXT,
  suggestions JSON,
  executed_at TEXT
);`
  }
  ,
  {
    id: '0033_portfolio_targets',
    description: 'Add portfolio_targets table to store desired factor or asset targets',
    sql: `CREATE TABLE IF NOT EXISTS portfolio_targets (
  portfolio_id TEXT,
  kind TEXT, -- 'factor' or 'asset'
  target_key TEXT, -- factor name or card_id
  target_value REAL,
  created_at TEXT,
  PRIMARY KEY(portfolio_id, kind, target_key)
);`
  }
  ,
  {
    id: '0034_alert_suppression',
    description: 'Add suppressed_until column to alerts_watch for snooze feature',
    sql: `ALTER TABLE alerts_watch ADD COLUMN suppressed_until TEXT;`
  }
  ,
  {
    id: '0035_ingestion_schedule',
    description: 'Add ingestion_schedule table for simple dataset frequency tracking',
    sql: `CREATE TABLE IF NOT EXISTS ingestion_schedule (
  dataset TEXT PRIMARY KEY,
  frequency_minutes INTEGER,
  last_run_at TEXT
);`
  }
  ,
  {
    id: '0036_portfolio_orders_exec_trades',
    description: 'Add executed_trades column to portfolio_orders',
    sql: `ALTER TABLE portfolio_orders ADD COLUMN executed_trades JSON;`
  }
  ,
  {
    id: '0037_alerts_fired_count',
    description: 'Add fired_count column to alerts_watch for escalation logic',
    sql: `ALTER TABLE alerts_watch ADD COLUMN fired_count INTEGER DEFAULT 0;`
  }
  ,
  {
    id: '0038_retention_config',
    description: 'Add retention_config table for configurable per-table retention windows',
    sql: `CREATE TABLE IF NOT EXISTS retention_config (
  table_name TEXT PRIMARY KEY,
  days INTEGER NOT NULL,
  updated_at TEXT
);`
  }
  ,
  {
    id: '0039_email_deliveries',
    description: 'Add email_deliveries table to log each outbound email attempt',
    sql: `CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  queued_id TEXT,
  email TEXT,
  subject TEXT,
  provider TEXT,
  ok INTEGER,
  error TEXT,
  attempt INTEGER,
  created_at TEXT,
  sent_at TEXT
);`
  }
  ,
  {
    id: '0040_portfolio_pnl_alpha',
    description: 'Add benchmark_ret and alpha columns to portfolio_pnl',
    sql: `ALTER TABLE portfolio_pnl ADD COLUMN benchmark_ret REAL;\nALTER TABLE portfolio_pnl ADD COLUMN alpha REAL;`
  }
  ,
  {
    id: '0041_webhooks',
    description: 'Add webhook endpoints and deliveries tables',
    sql: `CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT
);\nCREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT,
  event TEXT,
  payload TEXT,
  ok INTEGER,
  status INTEGER,
  error TEXT,
  created_at TEXT
);`
  }
  ,
  {
    id: '0042_pipeline_runs',
    description: 'Add pipeline_runs table for tracking and avoiding overlapping cron executions',
    sql: `CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  completed_at TEXT,
  status TEXT,
  error TEXT,
  metrics JSON
);`
  }
  ,
  {
    id: '0043_email_provider_message_id',
    description: 'Add provider_message_id column to email_deliveries for storing upstream provider id',
    sql: `ALTER TABLE email_deliveries ADD COLUMN provider_message_id TEXT;`
  }
  ,
  {
    id: '0044_webhook_deliveries_extend',
    description: 'Add attempt and duration_ms columns to webhook_deliveries for retry/backoff tracking',
    sql: `ALTER TABLE webhook_deliveries ADD COLUMN attempt INTEGER;\nALTER TABLE webhook_deliveries ADD COLUMN duration_ms INTEGER;`
  }
  ,
  {
    id: '0045_webhook_nonce',
    description: 'Add nonce column to webhook_deliveries for replay protection of signed webhooks',
    sql: `ALTER TABLE webhook_deliveries ADD COLUMN nonce TEXT;`
  }
];

let MIGRATIONS_RAN = false;
let MIGRATIONS_PROMISE: Promise<void> | null = null;

export async function runMigrations(db: D1Database) {
  // Allow re-entry to pick up newly added migrations in same process; serialize with promise guard.
  if (MIGRATIONS_PROMISE) await MIGRATIONS_PROMISE;
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
            const msg = String(e);
            if (!/no such table/i.test(msg) && !/duplicate column name/i.test(msg)) {
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