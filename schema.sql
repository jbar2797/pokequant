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
  cardmarket_url TEXT
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
