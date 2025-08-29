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
];

let MIGRATIONS_RAN = false;

export async function runMigrations(db: D1Database) {
  if (MIGRATIONS_RAN) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS migrations_applied (id TEXT PRIMARY KEY, applied_at TEXT, description TEXT);`).run();
  const existing = await db.prepare(`SELECT id FROM migrations_applied`).all();
  const have = new Set((existing.results||[]).map((r:any)=> String(r.id)));
  for (const m of migrations) {
    if (have.has(m.id)) continue;
    if (m.sql.trim() && !/^--/.test(m.sql.trim())) {
      // Split on ; but ignore inside simple contexts (baseline uses single statement so fine)
      const parts = m.sql.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean);
      for (const p of parts) {
        await db.prepare(p).run();
      }
    }
    await db.prepare(`INSERT INTO migrations_applied (id, applied_at, description) VALUES (?,?,?)`).bind(m.id, new Date().toISOString(), m.description||null).run();
  }
  MIGRATIONS_RAN = true;
}

export async function listMigrations(db: D1Database) {
  try {
    const rs = await db.prepare(`SELECT id, applied_at, description FROM migrations_applied ORDER BY id ASC`).all();
    return rs.results || [];
  } catch {
    return [];
  }
}