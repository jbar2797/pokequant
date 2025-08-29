-- db_migration.sql (idempotent) — create helpful indexes only
-- Safe to run multiple times; no ALTER TABLE here.

CREATE INDEX IF NOT EXISTS idx_prices_card_date   ON prices_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_svi_card_date      ON svi_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_signals_card_date  ON signals_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_sig_asof_card      ON signals_daily(as_of, card_id);
CREATE INDEX IF NOT EXISTS idx_comp_card_date     ON signal_components_daily(card_id, as_of);
CREATE INDEX IF NOT EXISTS idx_alerts_active_card ON alerts_watch(active, card_id);
CREATE INDEX IF NOT EXISTS idx_alerts_email       ON alerts_watch(email);
