# Changelog

All notable changes to this project will be documented here.

- Keep entries short. One bullet per meaningful change.
- Reference sprints or PRs if helpful.

## [Unreleased]
- …
- Track cache hit metrics (cache.hit.*) for public read endpoints
 - Add /admin/version for version introspection
 - Expose cache_hit_ratios in /admin/metrics
 - CI workflow: contract + version check, lint, typecheck, tests
 - Stronger ETag invalidation signature (include latest svi & component dates)
 - Document /admin/retention endpoint in OpenAPI and add component schemas for factor analytics
 - Add retention.spec.ts test to validate retention purge endpoint

## [0.2.5] - 2025-08-29
- Add /admin/integrity endpoint summarizing latest dates, coverage counts, gap heuristic, and stale datasets

## [0.2.6] - 2025-08-29
- Add data_completeness ledger (migration 0006) and surface recent completeness history in /admin/integrity

## [0.2.7] - 2025-08-29

## [0.4.1] - 2025-08-29
### Changed
- Optimized factor IC Spearman rank calculation to O(n log n) (removed O(n^2) indexOf usage) to prevent CI timeouts.
- Increased test-specific timeout for backtest & factor IC spec (15s) to reduce flakiness in slower CI runners.
### Fixed
- Addressed intermittent test timeout in backtest_ic.spec by performance improvements and timeout adjustment.

## [0.4.2] - 2025-08-29
### Changed
- Factor IC now uses forward return: ranks factor values on day D against price return from D to D+1, and stores IC under date D (observation date) instead of current day.

## [0.5.3] - 2025-08-30
### Fixed
- Auto factor weights endpoint now guarantees 200 with synthetic equal-weight fallback instead of 400 when no data present.

## [0.5.4] - 2025-08-30
### Added
- Factor IC computation now covers extended factor set: ts7, ts30, z_svi, risk(vol), liquidity, scarcity, mom90.

## [0.5.5] - 2025-08-30
### Added
- factor_config migration for dynamic factor universe
- /admin/factor-ic/summary endpoint (90d aggregate stats)
- Backtest txCostBps parameter for simple transaction cost modeling
### Changed
- Auto factor weights filtered to enabled factor universe
- Factor IC computation sources factor list from config table when present
- Added idempotence guard to skip recomputation if IC already present for a date.
### Notes
- This lays groundwork for evaluating predictive power without lookahead bias.

## [0.5.6] - 2025-08-30
### Added
### Changed

## [0.5.7] - 2025-08-30
### Added
- factor_returns table & computation (daily top-bottom quintile returns per factor)
- portfolio_factor_exposure snapshot table & cron snapshotter
- /admin/factor-returns (list) & /admin/factor-returns/run (manual recompute)
- /portfolio/exposure/history endpoint
- factor_returns data added to /admin/snapshot

## [0.5.8] - 2025-08-30
### Added
- Portfolio performance attribution endpoint /portfolio/attribution (factor contribution vs residual)
- Admin manual snapshot endpoints: /admin/portfolio-exposure/snapshot, /admin/portfolio-nav/snapshot
### Changed
- OpenAPI version bump to 0.5.8

## [0.5.9] - 2025-08-30
### Added
- Rolling factor IC summary window stats (full, 30d, 7d) with avg_ic, avg_abs_ic, hit_rate, ir per window (/admin/factor-ic/summary)
- Consolidated /admin/factor-performance endpoint combining factor returns + IC with suggested normalized weight_suggest
### Changed
- /admin/factor-returns now documents rolling aggregates in description
- OpenAPI version bump to 0.5.9

## [0.5.10] - 2025-08-30
### Added
- Ingestion provenance audit for backfill jobs: /admin/backfill POST now writes ingestion_provenance row (synthetic-backfill source) with lifecycle status/row count.
### Changed
- Internal refactor to isolate provenance logic within backfill handler (removed accidental earlier insertion noise).
- OpenAPI version bump to 0.5.10.

## [0.5.11] - 2025-08-30
### Added
- Mock external ingestion endpoint /admin/ingest/prices (deterministic pseudo data) with provenance source=external-mock.
### Changed
- Version bump to 0.5.11 (spec, package, version.ts) to include mock ingestion.

## [0.5.12] - 2025-08-30
### Added
- ingestion_config table + endpoints /admin/ingestion/config (GET, POST) for per-dataset/source cursor & enable tracking (migration 0019)
### Changed
- Provenance endpoint now supports filters (dataset, source, status, limit param)

## [0.5.13] - 2025-08-30
### Added
- /admin/ingestion/run endpoint: iterates enabled ingestion_config entries and ingests forward incremental prices_daily rows (cursor advanced, provenance recorded) with deterministic pseudo data scaffold.
### Changed
- Version bump to 0.5.13 (spec, package, version.ts)

## [0.5.14] - 2025-08-30
### Added
- mutation_audit table (migration 0020) and audit helper instrumentation across mutating endpoints (alerts create/deactivate, portfolios & lots, factor weights/config, ingestion run/config, backfill jobs, backtests, pipeline & factor runs, anomaly resolution)
- /admin/audit listing endpoint with optional filters (resource, action, limit)
### Changed
- Version bump to 0.5.14 (spec, package, version.ts)

## [0.5.15] - 2025-08-30
### Added
- Extended /admin/audit filters: actor_type, resource_id (in addition to resource, action, limit)
- Migration 0021 adds indexes on mutation_audit(actor_type) and action for faster filtered queries
### Changed
- Version bump to 0.5.15 (spec, package, version.ts)

## [0.5.16] - 2025-08-30
### Added
- Audit redaction (secrets/emails/tokens), pagination (before_ts), stats endpoint /admin/audit/stats
- Factor correlation matrix endpoint /admin/factor-correlations (rolling Pearson) with avg_abs_corr metric
- Migration 0022 adds composite index on factor_returns(as_of, factor) for correlation queries
### Changed
- Version bump to 0.5.16 (spec, package, version.ts)

## [0.5.17] - 2025-08-30
### Added
- Advanced factor risk & quality analytics: rolling covariance/correlation risk model (factor_risk_model), per-factor volatility & beta (factor_metrics), Bayesian-smoothed returns (factor_returns_smoothed), signal quality stability metrics (signal_quality_metrics), portfolio daily PnL (portfolio_pnl)
- New admin endpoints: /admin/factor-risk, /admin/factor-metrics, /admin/factor-returns-smoothed, /admin/signal-quality, /admin/portfolio-pnl
- Cron pipeline extended to populate new analytics daily (risk model, smoothed returns, signal quality, portfolio PnL)
### Changed
- Version bump to 0.5.17 (spec, package, version.ts)

## [0.5.18] - 2025-08-30
### Added
- Data retention helper purgeOldData invoked by daily cron (lightweight DELETE with table existence checks)
- On-demand retention endpoint /admin/retention (POST) returning per-table deleted row counts (audited)
### Changed
- Version bump to 0.5.18 (spec, package, version.ts)

## [0.4.3] - 2025-08-29
### Added
- Backfill jobs engine: POST /admin/backfill now creates a tracked job (backfill_jobs table) ingesting synthetic historical rows for prices_daily (idempotent fill) over requested day window.
- GET /admin/backfill lists recent jobs; GET /admin/backfill/{id} returns job detail.
### Internal
- Migration 0012_backfill_jobs for job tracking.
### Notes
- Current implementation generates synthetic backfill (copies last known price or random seed) as a scaffold for future real source integration.

## [0.4.4] - 2025-08-29
### Fixed
- Migration runner updated to always attempt applying new migrations within same worker lifecycle (allowed new 0012_backfill_jobs table to be created in tests).
### Changed
- OpenAPI: /admin/backfill now documents GET list, POST create, and new /admin/backfill/{id} detail path; removed erroneous duplicate POST block.

## [0.5.0] - 2025-08-29
### Added
- New factor component columns: liquidity (inverse volatility), scarcity (rarity heuristic), mom90 (90-day momentum) via migration 0013.
- Auto factor weighting endpoint /admin/factor-weights/auto deriving weights from trailing 30-day IC magnitudes.
### Changed
- Dynamic composite score now incorporates new factors when corresponding weights supplied (liquidity, scarcity, mom90).
### Notes
- Scarcity heuristic simplistic; future enhancement could use actual supply metrics.

## [0.5.1] - 2025-08-29
### Fixed
- Auto factor weights endpoint now retries IC computation and falls back to equal baseline weights if no IC data present, preventing 400 responses in fresh DB.

## [0.5.2] - 2025-08-29
### Fixed
- Auto factor weights endpoint now triggers signal component generation if absent so fallback weights always succeed on pristine databases.
- Add factor_weights table (migration 0007) with dynamic composite weighting and admin endpoints (/admin/factor-weights)

## [0.3.0] - 2025-08-29
- Add backtests table (migration 0008) & quintile spread backtest endpoints (/admin/backtests)
- Add factor_ic table (migration 0009) & IC endpoints (/admin/factor-ic, /admin/factor-ic/run)
- Add /admin/snapshot consolidated metadata endpoint
- Scheduled job computes daily factor IC

## [0.4.0] - 2025-08-29
- Add anomalies detection & /admin/anomalies (migration 0010)
- Add portfolio NAV snapshots & /admin/portfolio-nav (migration 0011)
- Integrate anomaly + portfolio NAV + IC + completeness into cron
- Add /admin/backfill placeholder endpoint

## [0.2.4] - 2025-08-29
- Add lightweight ETag support on public read endpoints (conditional GETs)
- Add standard X-RateLimit-* headers + Retry-After
- Spec bump to 0.2.4; document caching & rate limit headers
- Record latency & metrics for 304 responses

## [0.2.3] - 2025-08-29
- Add /admin/latency endpoint for latest p50/p95 snapshot
- Add Cache-Control headers to public read endpoints (universe/cards/movers/sets/rarities/types)
- Normalize alert threshold storage (migration 0005 adds threshold_usd)
- Broaden migration error tolerance (ignore duplicate column)

## [2025-08-29] Sprint 12.x
- Added /api/movers and Top Movers UI
- Restored endpoints and fixed UI init race
- Introduced SVI-only fallback and component storage
