Last Updated: 2025-09-01T05:28:00Z (export SLO_WINDOWS for debug endpoint; relax windows test for flake reduction)
# Engineering Snapshot (Rolling)

> Single source of truth for current state, active goals, and next actions. Update this file *with every meaningful refactor or feature batch* before committing.

Last Updated: 2025-08-31T23:40:00Z (rolling SLO breach ratio gauge + public rate limiting expansion + email bounce ingestion + log enrichment fix)

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
| Metrics & Latency | lib/metrics.ts, /admin/metrics routes/admin.ts, router.ts | Stable | Route SLO classification, buckets, rolling breach ratio gauge. |
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


## 3. Completed Alpha Hardening Goals (Week 1–2)
- [x] Error & status-class request metrics (exposed via /admin/metrics)
- [x] Hash ingest token + dual admin token support
- [x] Anomalies & backfill pagination
- [x] Retention configuration table & CRUD
- [x] OpenAPI spec updated (pagination params + new endpoints)
- [x] Factor explainability endpoint (`/api/card/factors`)
- [x] Portfolio benchmark series + alpha in `/portfolio/pnl`
- [x] Email delivery logging table + admin listing endpoint
- [x] Webhook alert infrastructure (simulated deliveries + retry/backoff + redelivery + replay verify)
- [x] Dynamic per-route SLO thresholds + classification metrics
- [x] Latency bucket metrics & percentile smoothing stabilization
- [x] Latency ensure missing-table noise suppression (silent first retry)
- [x] Log capture test utilities & assertion of zero `metric_latency_error` on cold start

## 3a. Production Hardening Sprint (Beta Gate) – Proposed Major Feature Focus
Focus only on high-leverage features; defer cosmetic/detail polish:
- [ ] Real email provider (Resend or Postmark) selection & abstraction finalize
   - Adapter interface hardened; add bounce webhook ingestion + status update (delivered, bounced, complaint)
   - Delivery metrics: `email.delivered`, `email.bounced`, `email.complaint`
- [ ] Real webhook dispatch toggle (feature flag) + HMAC signature (payload + nonce + timestamp) + secret rotation flow
   - Delivery success/error SLIs + retry budget metrics
- [ ] Error taxonomy expansion: map internal errors to stable `error_code` enums; aggregate counters & dashboard docs
- [ ] Coverage ratchet automation wired into CI (already script; add safeguarded auto-commit) + badge update step (DONE for badge asset, not automated commit gate)
- [ ] Structured log shipping plan (even if manual) + minimal redaction policy (confirm no secrets in logs)
- [ ] Rate limit expansion to remaining public endpoints (cards, movers, sets, rarities) with adaptive defaults
- [ ] Frontend core SPA (minimal) delivering: Cards list, Card detail, Movers, Portfolio lots+PnL read-only
   - Auth token handling + ETag client caching
- [x] SLO breach alerting primitive: rolling breach ratio gauge metric (foundation for alerting pipeline)

Definition of Done (Sprint): All above either shipped or time-boxed decisions recorded (provider choice, signature spec) with docs updated.

## 4. Ready / Next Up (post 0.8.0)
- [x] SLO documentation expansion in API_CONTRACT (brief reference) & operations runbook alerting tie-in
- [ ] Coverage badge automation (thresholds already enforced)
- [ ] Provider selection decision (Resend vs Postmark) finalize & document
- [ ] Real email provider domain configuration (SPF/DKIM) & bounce webhook ingestion
- [ ] Route-level error taxonomy (group specific error codes)

## 5. Parking Lot / Future Enhancements
- What-if portfolio scenario endpoint
- Materialized factor snapshot & small LRU cache
- Coverage ratchet in CI + threshold gate
- Architecture diagram documentation page
- Benchmark methodology refinement (current equals simple derived baseline)
- Portfolio risk decomposition (factor vs residual volatility)

## 6. Recently Completed (chronological, newest first, trimmed)
0. SLO windows debug endpoint + log redaction shallow object support + tests (0.8.3) — 2025-08-31
1. Rolling SLO breach ratio gauge + log enrichment context (0.8.2) — 2025-08-31
2. Latency ensure noise suppression + log capture assertion (0.8.1) — 2025-08-31
3. Dynamic per-route SLO thresholds + classification metrics (0.8.0) — 2025-08-31
2. Manual webhook redelivery endpoint (/admin/webhooks/redeliver) — 2025-08-31
3. Webhook replay verification endpoint (/admin/webhooks/verify) — 2025-08-31
4. Portfolio scenario what-if exposures endpoint (/portfolio/scenario) — 2025-08-31
5. Webhook signing scaffolding (nonce replay metadata, planned_backoff_ms field, simulated vs real metrics namespaces) — 2025-08-31
6. Webhook retry/backoff (attempt & duration_ms columns, metrics webhook.sent/retry_success/error) + tests (0.7.8) — 2025-08-30
7. Email provider_message_id persistence + OpenAPI schema + test (0.7.7) — 2025-08-30
8. Pipeline run tracking table + overlap guard + /admin/pipeline/runs endpoint (0.7.6) — 2025-08-30
9. Correlation ID propagation (x-request-id) + latency bucket metrics (latbucket.*) — 2025-08-30
10. Webhook alert infrastructure (tables, /admin/webhooks*, simulated deliveries) — 2025-08-30
11. Email delivery logging (table + /admin/email/deliveries) — 2025-08-30
12. Portfolio benchmark_ret + alpha computation & exposure via endpoints — 2025-08-30
13. Factor explainability endpoint `/api/card/factors` — 2025-08-30
14. Retention config table + CRUD endpoints — 2025-08-30

## 7. Quality Gates Snapshot
- Tests: 116 passing (full suite) (added slo_windows + log_redaction specs; windows endpoint exported)
- Coverage: thresholds enforced (lines 67%, functions 59%, branches 48%, statements 59%) – ratchet script present, CI auto-bump pending
- Contract Check: Passing (`scripts/contract-check.js`)
- Version Sync: Passing (`scripts/version-check.js`)

## 8. Operational TODOs (Condensed High-Leverage)
| TODO | Stage | Priority | Notes |
|------|-------|----------|-------|
| Email provider productionization (send + bounce/complaint ingest) | Beta Gate | P0 | Decide provider, implement adapter + webhook | 
| Webhook real dispatch + HMAC signature + secret rotation | Beta Gate | P0 | Feature flag `WEBHOOK_REAL=1`; audit retries |
| Error taxonomy & aggregation (stable codes) | Beta Gate | P0 | Map internal errors -> codes + metrics | 
| Coverage ratchet CI auto-commit | Beta Gate | P1 | Use existing script + protected branch rules |
| Rate limit expansion (cards/movers/etc) | Beta Gate | P1 | Reuse existing limiter infra |
| Structured log shipping plan & redaction review | Beta | P1 | Evaluate R2 log sink or external collector |
| SLO breach rolling ratio metric & alert doc | Beta | P1 | Metric: `req.slo.breach_ratio_WINDOW` (computed) |
| Frontend core SPA (minimal pages) | Beta | P1 | Replace static HTML pages |
| Benchmark methodology doc | Post-Beta | P2 | Clarify baseline strategy |
| Portfolio risk decomposition (future) | GA+ | P3 | Requires factor residual calc |

## 9. Update Protocol
1. Before merging any feature/refactor, update:
   - Active Sprint Goals checkboxes
   - Recently Completed list (prepend newest; trim >8)
   - Quality Gates (if counts change)
2. Keep items granular but batch-able (< ~150 LOC per commit when risky).
3. If scope changes mid-sprint, move undone goal to Ready / Parking Lot explicitly (never silently drop).
4. Reference this file in commit messages when completing checklist items (e.g., "feat(metrics): add error counters (snapshot #Active Sprint Goals)").

## 10. Open Questions (Capture & Resolve)
- Email provider decision (Resend vs Postmark) – target decision early Sprint
- Bounce / complaint schema (single table vs normalized events) – decide with provider choice
- Webhook signing canonical string (payload JSON + timestamp + nonce?) – finalize before enabling real dispatch
- Coverage ratchet gating strategy (auto commit vs fail-only) – decide with CI update
- Default retention windows per table (document baseline policy)
- Benchmark construction (equal-weight vs heuristic top-N) – doc after provider + webhook done

---
(Automate future date stamping with a small pre-commit hook if desired.)
