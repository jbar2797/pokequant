## Data Dictionary (Initial Seed)

Generated manually from `schema.sql` / migrations (will automate).

Table: cards
Column | Type | Notes
id | TEXT PK | Card identifier (e.g., set_code-number)
name | TEXT | Display name
set_name | TEXT | Expansion / set
rarity | TEXT | Rarity string
image_url | TEXT | (Optional) CDN URL
types | TEXT | Comma delimited types

Table: prices_daily
card_id (FK cards.id), as_of (DATE), price_usd (REAL), price_eur (REAL optional), src_updated_at (TEXT)
PK(card_id, as_of)

Table: signals_daily
card_id, as_of, score, signal (BUY/HOLD/SELL), reasons (JSON array), edge_z, exp_ret, exp_sd
PK(card_id, as_of)

Table: signal_components_daily
card_id, as_of, ts7, ts30, dd, vol, z_svi, regime_break, liquidity, scarcity, mom90
PK(card_id, as_of)

Table: portfolios
id TEXT PK, name TEXT, secret_hash TEXT, created_at TEXT

Table: portfolio_lots
id TEXT PK, portfolio_id FK, card_id, qty REAL, price_usd REAL, acquired_at TEXT

Table: alerts
id TEXT PK, type TEXT, card_id TEXT, portfolio_id TEXT?, threshold REAL?, created_at TEXT, status TEXT

Table: pipeline_runs
id TEXT PK, started_at TEXT, completed_at TEXT, status TEXT, error TEXT, metrics JSON

Additional tables exist for factors, anomalies, metrics_daily, backups, webhooks, slo_config, etc. Expand in subsequent iteration.

Automation TODO:
- Script to introspect D1 schema and regenerate this file; fail CI if drift.
