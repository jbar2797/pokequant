-- Reference cards
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  name TEXT,
  set_id TEXT,
  set_name TEXT,
  number TEXT,
  rarity TEXT,
  image_url TEXT,
  tcgplayer_url TEXT,
  cardmarket_url TEXT,
  types TEXT                -- pipe-delimited types tokens
);

-- Our canonical daily price history (we snapshot this ourselves)
CREATE TABLE IF NOT EXISTS prices_daily (
  card_id TEXT,
  as_of DATE,
  price_usd REAL,
  price_eur REAL,
  src_updated_at TEXT,
  PRIMARY KEY (card_id, as_of)
);

-- Google Trends SVI (0..100), per card & date
CREATE TABLE IF NOT EXISTS svi_daily (
  card_id TEXT,
  as_of DATE,
  svi INTEGER,
  PRIMARY KEY (card_id, as_of)
);

-- Derived signals: Buy/Hold/Sell & explainability
CREATE TABLE IF NOT EXISTS signals_daily (
  card_id TEXT,
  as_of DATE,
  score REAL,
  signal TEXT,         -- BUY | HOLD | SELL
  reasons TEXT,        -- JSON array of reason strings
  edge_z REAL,         -- expected-return / uncertainty
  exp_ret REAL,        -- expected next-day return (log)
  exp_sd REAL,         -- expected next-day SD
  PRIMARY KEY (card_id, as_of)
);

-- Email subscriptions (MVP)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,              -- UUID
  kind TEXT,                        -- 'email'
  target TEXT,                      -- email address
  created_at TEXT
);

-- Alert rules
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  subscription_id TEXT,
  card_id TEXT,
  rule TEXT,                        -- 'signal-change' or 'price-below:<num>'
  last_notified TEXT
);

-- Sprint 6: portfolios and lots (P&L)
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,        -- random UUID
  secret TEXT NOT NULL,       -- random hex secret (capability token)
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,        -- random UUID
  portfolio_id TEXT,
  card_id TEXT,
  qty REAL,                   -- > 0
  cost_usd REAL,              -- total cost in USD for this lot (not per-unit)
  acquired_at TEXT,           -- ISO date 'YYYY-MM-DD'
  note TEXT,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
);

CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_lots_card ON lots(card_id);

-- Sprint 7: store per-day signal components for research/export
CREATE TABLE IF NOT EXISTS signal_components_daily (
  card_id TEXT,
  as_of DATE,
  ts7 REAL,          -- Theil–Sen slope over last 7
  ts30 REAL,         -- Theil–Sen slope over last 30
  dd REAL,           -- drawdown from 90d peak (0..1)
  vol REAL,          -- MAD of daily log-returns
  z_svi REAL,        -- z-score of recent SVI change (or 0 if SVI not used)
  regime_break INTEGER, -- 0/1
  PRIMARY KEY (card_id, as_of)
);

-- Sprint 9: Watchlist alerts (and ensure portfolio tables exist)

CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  qty REAL NOT NULL,
  cost_usd REAL NOT NULL,
  acquired_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_lots_portfolio ON lots(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_lots_card ON lots(card_id);

-- A separate table for price alerts to avoid conflicts with any earlier 'alerts' table.
CREATE TABLE IF NOT EXISTS alerts_watch (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'price_above' | 'price_below'
  threshold_usd REAL NOT NULL,     -- stored in USD; request body uses 'threshold'
  created_at TEXT,
  last_fired_at TEXT,
  active INTEGER DEFAULT 1,
  manage_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_watch_card ON alerts_watch(card_id);
CREATE INDEX IF NOT EXISTS idx_alerts_watch_email ON alerts_watch(email);



