## Data Dictionary (Automated Extract)

Generated: 2025-09-01T22:32:57.001Z

### Table: cards
Column | Type | Notes
------ | ---- | -----
id | TEXT | PRIMARY KEY,
name | TEXT | ,
set_id | TEXT | ,
set_name | TEXT | ,
number | TEXT | ,
rarity | TEXT | ,
image_url | TEXT | ,
tcgplayer_url | TEXT | ,
cardmarket_url | TEXT | ,
types | TEXT | -- pipe-delimited types tokens

### Table: prices_daily
Column | Type | Notes
------ | ---- | -----
card_id | TEXT | ,
as_of | DATE | ,
price_usd | REAL | ,
price_eur | REAL | ,
src_updated_at | TEXT | ,

### Table: svi_daily
Column | Type | Notes
------ | ---- | -----
card_id | TEXT | ,
as_of | DATE | ,
svi | INTEGER | ,

### Table: signals_daily
Column | Type | Notes
------ | ---- | -----
card_id | TEXT | ,
as_of | DATE | ,
score | REAL | ,
signal | TEXT | ,         -- BUY | HOLD | SELL
reasons | TEXT | ,        -- JSON array of reason strings
edge_z | REAL | ,         -- expected-return / uncertainty
exp_ret | REAL | ,        -- expected next-day return (log)
exp_sd | REAL | ,         -- expected next-day SD

### Table: subscriptions
Column | Type | Notes
------ | ---- | -----
id | TEXT | PRIMARY KEY,              -- UUID
kind | TEXT | ,                        -- 'email'
target | TEXT | ,                      -- email address
created_at | TEXT | 

### Table: alerts
Column | Type | Notes
------ | ---- | -----
id | TEXT | PRIMARY KEY,
subscription_id | TEXT | ,
card_id | TEXT | ,
rule | TEXT | ,                        -- 'signal-change' or 'price-below:<num>'
last_notified | TEXT | 

### Table: portfolios
Column | Type | Notes
------ | ---- | -----
id | TEXT | PRIMARY KEY,        -- random UUID
secret | TEXT | NOT NULL,       -- random hex secret (capability token)
created_at | TEXT | 

### Table: lots
Column | Type | Notes
------ | ---- | -----
id | TEXT | PRIMARY KEY,        -- random UUID
portfolio_id | TEXT | ,
card_id | TEXT | ,
qty | REAL | ,                   -- > 0
cost_usd | REAL | ,              -- total cost in USD for this lot (not per-unit)
acquired_at | TEXT | ,           -- ISO date 'YYYY-MM-DD'
note | TEXT | ,
FOREIGN | KEY | (portfolio_id) REFERENCES portfolios(id)

### Table: signal_components_daily
Column | Type | Notes
------ | ---- | -----
card_id | TEXT | ,
as_of | DATE | ,
ts7 | REAL | ,          -- Theil–Sen slope over last 7
ts30 | REAL | ,         -- Theil–Sen slope over last 30
dd | REAL | ,           -- drawdown from 90d peak (0..1)
vol | REAL | ,          -- MAD of daily log-returns
z_svi | REAL | ,        -- z-score of recent SVI change (or 0 if SVI not used)
regime_break | INTEGER | , -- 0/1


(Do not edit manually – run `npm run data:dict` to regenerate.)
