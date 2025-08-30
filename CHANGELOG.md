# Changelog

All notable changes to this project will be documented here.

- Keep entries short. One bullet per meaningful change.
- Reference sprints or PRs if helpful.

## [Unreleased]
- …
- Track cache hit metrics (cache.hit.*) for public read endpoints

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
