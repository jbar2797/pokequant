# Engineering Snapshot (Rolling)

> Single source of truth for current state, active goals, and next actions. Update this file *with every meaningful refactor or feature batch* before committing.

Last Updated: 2025-08-30T22:30:00Z (sprint started; request metrics instrumentation added)

## 1. High-Level Architecture
- Cloudflare Worker (TypeScript) + D1 (SQLite) backing store
- Modular route files under `src/routes/*` registering on-demand via dynamic imports in `index.ts`
- Domain libs under `src/lib/*` for factors, metrics, audit, retention, integrity, portfolio nav/pnl, ingestion, rate limiting, crypto, etc.
- Nightly cron (pipeline) performs: universe fetch → price snapshot → signals compute → factor analytics → exposures snapshot → NAV/PnL snapshot → alerts evaluation → retention (optional) → anomaly detection.
- OpenAPI spec (`openapi.yaml`) + contract check script ensures parity.

## 2. Module Inventory & Status
| Area | File(s) | Status | Notes |
|------|---------|--------|-------|
| Public API | routes/public.ts, routes/metadata.ts, routes/search.ts | Stable | Cache headers + ETags implemented. |
| Portfolio Core | routes/portfolio.ts, lib/portfolio_auth.ts | Stable | Secrets hashed; rotation endpoint covered. |
| Portfolio Analytics | lib/portfolio_nav.ts, routes/portfolio_nav.ts | NEW modularized | NAV snapshot & PnL extraction separated from index. |
| Backfill | routes/backfill.ts | NEW modularized | Supports synthetic price backfill. Pagination TODO. |
| Anomalies | routes/anomalies.ts | NEW modularized | Resolution + status filter. Pagination TODO. |
| Factors & Analytics | routes/factors.ts, lib/factors/* | Stable | Includes returns, risk, smoothing, IC, quality. |
| Alerts | routes/alerts.ts, email_adapter.ts | Partial | Email send stub; provider integration pending. |
| Metrics & Latency | lib/metrics.ts, /admin/metrics routes/admin.ts | Stable | Missing error counters. |
| Integrity & Retention | lib/integrity.ts, lib/retention.ts, routes/admin.ts | Stable | Config persistence enhancement planned. |
| Ingestion & Provenance | lib/ingestion.ts, routes/admin.ts | Stable | Incremental run + provenance listing. |
| Audit | lib/audit.ts, routes/admin.ts | Stable | Pagination + stats endpoints exist. |
| Rate Limiting | lib/rate_limit.ts | Stable | Headers standardized; confirm coverage. |
| Security Tokens | portfolio_auth, admin, ingest | Needs Hardening | Ingest token not hashed yet; dual admin token rotation missing. |

## 3. Active Sprint Goals (Week 1–2 Hardening)
- [x] Error & status-class request metrics (expose via /admin/metrics) — initial counters added (req.total, req.status.*xx, request.error.*)
- [ ] Hash ingest token + dual admin token support
- [ ] Anomalies & backfill pagination (limit + cursor)
- [ ] Retention configuration table & CRUD
- [ ] OpenAPI spec updated for new modular routes + backfill detail

## 4. Ready / Next Up (after Sprint Goals)
- [ ] Email provider integration + delivery events table
- [ ] Factor explainability endpoint (`/api/card/factors`)
- [ ] Portfolio benchmark series + alpha in `/portfolio/pnl`

## 5. Parking Lot / Future Enhancements
- Webhook alerts
- What-if portfolio scenario endpoint
- Structured logging envelope + request correlation ID
- Pipeline run tracking table (idempotency + advisory lock)
- Materialized factor snapshot & small LRU cache
- Coverage ratchet in CI + threshold gate
- Architecture diagram documentation page

## 6. Recently Completed (chronological, last 8)
0. Sprint kickoff & request metrics instrumentation (req.total/status/error) — 2025-08-30
1. Extract anomalies routes to `routes/anomalies.ts`
2. Extract backfill routes to `routes/backfill.ts`
3. Extract portfolio NAV & PnL routes + move helpers to `lib/portfolio_nav.ts`
4. Deduplicate integrity & retention helpers (moved to lib)
5. Factor endpoints moved earlier to `routes/factors.ts`
6. Restored missing `/admin/portfolio-pnl` after earlier refactor
7. Added dynamic route module imports in `index.ts`
8. General test suite stabilization after modularization

## 7. Quality Gates Snapshot
- Tests: 64 passing (vitest)
- Coverage: lcov present (see `coverage/index.html`) – (record % here on update)
- Contract Check: Passing (`scripts/contract-check.js`)
- Version Sync: Passing (`scripts/version-check.js`)

## 8. Operational TODOs
| TODO | Owner | Target | Notes |
|------|-------|--------|-------|
| Add request.error.* counters | | Sprint | Extend router wrapper try/catch |
| Add pipeline_runs table | | Mid-term | Guard overlapping cron runs |
| Hash ingest token | | Sprint | Mirror portfolio secret hashing |
| Dual admin token window | | Sprint | Accept ADMIN_TOKEN & ADMIN_TOKEN_NEXT |

## 9. Update Protocol
1. Before merging any feature/refactor, update:
   - Active Sprint Goals checkboxes
   - Recently Completed list (prepend newest; trim >8)
   - Quality Gates (if counts change)
2. Keep items granular but batch-able (< ~150 LOC per commit when risky).
3. If scope changes mid-sprint, move undone goal to Ready / Parking Lot explicitly (never silently drop).
4. Reference this file in commit messages when completing checklist items (e.g., "feat(metrics): add error counters (snapshot #Active Sprint Goals)").

## 10. Open Questions (Capture & Resolve)
- Which email provider (Resend vs Postmark) → decision pending.
- Benchmark construction method (equal-weight vs top-N) → TBD.
- Retention windows default policy per table → document when adding config.

---
(Automate future date stamping with a small pre-commit hook if desired.)
