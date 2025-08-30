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
