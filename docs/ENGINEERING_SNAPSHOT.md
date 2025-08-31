# Engineering Snapshot (Rolling)

> Single source of truth for current state, active goals, and next actions. Update this file *with every meaningful refactor or feature batch* before committing.

Last Updated: 2025-08-31T01:10:00Z (webhook replay verify endpoint, portfolio scenario what-if exposures)

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
| Backfill | routes/backfill.ts | NEW modularized | Supports synthetic price backfill w/ cursor pagination. |
| Anomalies | routes/anomalies.ts | NEW modularized | Resolution + status filter + cursor pagination. |
| Factors & Analytics | routes/factors.ts, lib/factors/* | Stable | Includes returns, risk, smoothing, IC, quality. |
| Alerts | routes/alerts.ts, email_adapter.ts | Improved | Provider message id persistence + retry metrics; real external provider path in place (Resend) pending prod key. |
| Metrics & Latency | lib/metrics.ts, /admin/metrics routes/admin.ts | Stable | Missing error counters. |
| Integrity & Retention | lib/integrity.ts, lib/retention.ts, routes/admin.ts | Stable | Retention config CRUD implemented (0038). |
| Ingestion & Provenance | lib/ingestion.ts, routes/admin.ts | Stable | Incremental run + provenance listing. |
| Audit | lib/audit.ts, routes/admin.ts | Stable | Pagination + stats endpoints exist. |
| Rate Limiting | lib/rate_limit.ts | Stable | Headers standardized; confirm coverage. |
| Security Tokens | portfolio_auth, admin, ingest | Stable | Dual admin token & ingest hashed-or-plaintext auth complete. |

### Migrations & Test Seeding
Cloudflare Workers Vitest provides a fresh D1 storage per test file while reusing the JS isolate. A simple global "migrations already ran" flag caused missing tables in later specs. Current strategy:

* `runMigrations` attaches `__MIGRATIONS_LOCK` / `__MIGRATIONS_DONE` to the concrete D1Database object (not global) and performs an integrity probe (checks `cards` table) before early-returning. If storage rotated, it replays idempotent migrations.
* Each migration is recorded in `migrations_applied`; replays skip existing IDs so the cost after first run per DB is negligible.
* `ensureTestSeed` similarly uses per-DB markers so a new ephemeral DB still gets core seed rows/tables once.
* Defensive `CREATE TABLE IF NOT EXISTS` statements remain at some route boundaries for robustness, but most core schema is in migrations.

Operational notes: append new migrations with monotonic ids; prefer additive, idempotent ALTERs / CREATEs guarded by IF NOT EXISTS. Avoid irreversible data rewrites without presence checks.


## 3. Active Sprint Goals (Week 1–2 Hardening)
- [x] Error & status-class request metrics (expose via /admin/metrics)
- [x] Hash ingest token + dual admin token support
- [x] Anomalies & backfill pagination
- [x] Retention configuration table & CRUD
- [x] OpenAPI spec updated for new modular routes + pagination params + retention config endpoints (rolled into broader spec sync 0.7.5)
- [x] Factor explainability endpoint (`/api/card/factors`)
- [x] Portfolio benchmark series + alpha in `/portfolio/pnl`
- [x] Email delivery logging table + admin listing endpoint
- [x] Webhook alert infrastructure (endpoints + simulated deliveries)

## 4. Ready / Next Up (post 0.7.9)
- [ ] Coverage badge automation (thresholds already enforced)
- [ ] Architecture diagram & docs page (mermaid + explanation)
- [ ] Provider selection decision (Resend vs Postmark) finalize & document
- [ ] Real email provider domain configuration (SPF/DKIM) & bounce webhook ingestion
- [ ] Manual webhook re-delivery trigger (admin) leveraging verify endpoint

## 5. Parking Lot / Future Enhancements
- What-if portfolio scenario endpoint
- Materialized factor snapshot & small LRU cache
- Coverage ratchet in CI + threshold gate
- Architecture diagram documentation page
- Benchmark methodology refinement (current equals simple derived baseline)
- Portfolio risk decomposition (factor vs residual volatility)

## 6. Recently Completed (chronological, newest first, trimmed)
0. Webhook replay verification endpoint (/admin/webhooks/verify) — 2025-08-31
1. Portfolio scenario what-if exposures endpoint (/portfolio/scenario) — 2025-08-31
2. Webhook signing + nonce replay metadata + planned_backoff_ms + real vs simulated metrics namespaces — 2025-08-31
3. Webhook retry/backoff (attempt & duration_ms columns, metrics webhook.sent/retry_success/error) + tests (0.7.8) — 2025-08-30
4. Email provider_message_id persistence + OpenAPI schema + test (0.7.7) — 2025-08-30
5. Pipeline run tracking table + overlap guard + /admin/pipeline/runs endpoint (0.7.6) — 2025-08-30
6. Correlation ID propagation (x-request-id) + latency bucket metrics (latbucket.*) — 2025-08-30
7. Webhook alert infrastructure (tables, /admin/webhooks*, simulated deliveries) — 2025-08-30
8. Email delivery logging (table + /admin/email/deliveries) — 2025-08-30
9. Portfolio benchmark_ret + alpha computation & exposure via endpoints — 2025-08-30
10. Factor explainability endpoint `/api/card/factors` — 2025-08-30
11. Retention config table + CRUD endpoints — 2025-08-30
12. Anomalies & backfill pagination + tests — 2025-08-30

## 7. Quality Gates Snapshot
- Tests: 77+ passing (additions pending)
- Coverage: thresholds enforced (lines 60%, functions 60%, branches 50%, statements 60%) – badge automation pending
- Contract Check: Passing (`scripts/contract-check.js`)
- Version Sync: Passing (`scripts/version-check.js`)

## 8. Operational TODOs
| TODO | Owner | Target | Notes |
|------|-------|--------|-------|
| Real email provider productionization |  | Short | Configure domain, handle bounces/errors |
| Real webhook dispatch enable & signing |  | Short | HMAC header + nonce replay guard |
| Request error counters expansion |  | Short | Distinguish 4xx vs 5xx granularly |
| Pipeline run tracking table |  | Done | Prevent overlapping cron runs |
| Structured logging + correlation id |  | Mid | Add request_id & span friendly format |
| Coverage threshold ratchet |  | Mid | Fail CI if coverage drops |
| Benchmark methodology doc |  | Mid | Document construction & alternatives |

## 9. Update Protocol
1. Before merging any feature/refactor, update:
   - Active Sprint Goals checkboxes
   - Recently Completed list (prepend newest; trim >8)
   - Quality Gates (if counts change)
2. Keep items granular but batch-able (< ~150 LOC per commit when risky).
3. If scope changes mid-sprint, move undone goal to Ready / Parking Lot explicitly (never silently drop).
4. Reference this file in commit messages when completing checklist items (e.g., "feat(metrics): add error counters (snapshot #Active Sprint Goals)").

## 10. Open Questions (Capture & Resolve)
- Which email provider (Resend vs Postmark) → decision pending (currently test-mode Resend simulation).
- Benchmark construction method (equal-weight vs top-N) → TBD.
- Retention windows default policy per table → document when adding config.
- Webhook signing scope: include nonce + timestamp vs simple payload HMAC → TBD.

---
(Automate future date stamping with a small pre-commit hook if desired.)
