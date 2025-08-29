-- db_migration.sql — run against remote D1 before deploying new Worker
-- Adds optional columns to 'cards' and helpful indexes. Safe to re-run; ignore "duplicate column" errors.

-- Add columns (ignore errors if they already exist)
ALTER TABLE cards ADD COLUMN types TEXT;
ALTER TABLE cards ADD COLUMN supertype TEXT;
ALTER TABLE cards ADD COLUMN subtypes TEXT;

-- Helpful indexes for search
CREATE INDEX IF NOT EXISTS idx_cards_name   ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_set    ON cards(set_name);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
CREATE INDEX IF NOT EXISTS idx_cards_types  ON cards(types);