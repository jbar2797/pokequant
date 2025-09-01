# PokeQuant ![Coverage](public/coverage-badge.svg)

Edge analytics & factor / signal intelligence for premium Pokémon TCG cards.

Status: ALPHA (backend feature-complete for initial trials; frontend undergoing full redesign).

## 0. What This Is
An analytics service that ingests card price & search interest data, computes multi-factor signals, and provides portfolio & alert tooling over an edge (Cloudflare Worker + D1) stack with low-latency public APIs.

## 1. Quick Start (Developer)
```
npm install
make dev          # local worker (wrangler)
make test         # vitest suite (isolated D1 per spec)
make lint
make typecheck
make smoke BASE=http://127.0.0.1:8787
```
Deploy:
```
make deploy
```

### Environment / Secrets
Set via Wrangler secrets / vars:
- ADMIN_TOKEN, ADMIN_TOKEN_2 (dual admin auth)
- INGEST_TOKEN (GitHub Actions trends ingest)
- EMAIL_PROVIDER_API_KEY (planned – not yet required)
- WEBHOOK_SIGNING_SECRET (planned – for signed deliveries)

Rate limit overrides:
RL_SEARCH_LIMIT / RL_SEARCH_WINDOW_SEC
RL_SUBSCRIBE_LIMIT / RL_SUBSCRIBE_WINDOW_SEC
RL_ALERT_CREATE_LIMIT / RL_ALERT_CREATE_WINDOW_SEC

### Auth Headers
Admin: `x-admin-token`
Ingest: `x-ingest-token`
Portfolio: `x-portfolio-id`, `x-portfolio-secret`

## 2. Architecture (High Level)
Cloudflare Worker (TypeScript)
D1 (SQLite) for operational store (migrations in `src/migrations.ts`)
Nightly pipeline (cron) → universe ingest, prices snapshot, signals, factor analytics, alerts, retention
Public + admin routes (modular under `src/routes/*`)
Metrics & latency captured in D1 (EMAs) surfaced via `/admin/metrics`

See `docs/ARCHITECTURE.md` for diagram & deeper notes.

## 3. Current Feature Matrix (Alpha)
Core ingestion (universe, prices, SVI) ✔
Signals & factor analytics (IC, returns, risk, explainability) ✔
Portfolio lots, PnL, exposure, attribution, scenario ✔
Alerts creation, evaluation, email/webhook simulation ✔ (real provider pending)
Webhooks (signed simulation, replay verify) ✔ (real dispatch off by default)
Email logging simulated ✔ (real provider pending)
Search + metadata (sets, rarities, types) ✔
Caching (ETag + short TTL cache-control) ✔
Rate limiting (search, subscribe, alert create) ✔ (expansion planned)

Frontend: basic static pages (to be replaced) ✖ (rewrite in progress – see `docs/FRONTEND_PLAN.md`).

## 4. Production Readiness Gaps
Frontend UX overhaul
Real email provider integration & bounce webhook
Webhook real delivery + HMAC signature + replay guard hardening
Structured logging & per-route error/latency dashboards
Granular error dashboards (aggregation & alert thresholds) – base error/status metrics implemented (`error.*`, `error_status.*`)
Coverage badge & ratchet (CI gate) ✔
Architecture + Runbook docs finalization
Security review (headers, secrets rotation automation)

### Coverage Ratchet
`npm run coverage:ratchet` will auto-bump coverage thresholds by +1 (lines/functions/statements/branches) when the current coverage exceeds the existing threshold by >=2 percentage points. This should run after meaningful test additions (can be integrated as an optional CI step that only commits when bumps occur).

## 5. Roadmap (Alpha → Beta → GA)
See `docs/ROADMAP.md` for dated milestones.

Immediate (Week 1): email provider, webhook signature, coverage badge (error metrics done)
Short (Weeks 2–3): frontend rewrite, structured logging, rate limit expansion
Beta Gate: production pipeline stability (30d), user feedback loops, onboarding docs
GA: performance benchmarks, SLA metrics, billing / access tiering (if pursued)

## 6. API / Contract
Canonical: `openapi.yaml` + `docs/API_CONTRACT.md`. All public/admin changes MUST pass contract check (`npm run contract`).

## 7. CI & Quality Gates
`ci.yml` (FAST_TESTS=1) → install, contract check, version check, lint, typecheck, tests (fast migrations mode + coverage), badge generation, smoke preview, performance smoke (latency p95 budget)
`nightly-full.yml` (FAST_TESTS=0) → full migrations + typecheck + full tests (no fast path) + lightweight preview smoke to catch drift
`smoke.yml` (prod smoke) conditional on public base URL
Implemented: performance smoke gate, Prometheus export (`/admin/metrics-export`) with counters, errors, status families, latency gauges.

## 8. Operations (Preview)
Runbook: `docs/OPERATIONS_RUNBOOK.md` (cron failures, backlog recovery, retention tuning)
Metrics: `/admin/metrics` (counters + latency EMAs, error code & status counters).
Retention: configurable table policies (see retention config endpoints) – review weekly.

## 9. Security & Secrets
All tokens hashed or rotated; portfolio secrets hashed (legacy plaintext phased out). Provide rotation endpoints for portfolio; admin & ingest rotate via redeploy.
Planned: automatic key rotation guidelines + optional KMS-backed secret fetch.

## 10. Frontend Overhaul
Pending rewrite (framework evaluation: SvelteKit vs Next.js static export). See `docs/FRONTEND_PLAN.md` for acceptance criteria & component spec.

## 11. Contributing (Internal Alpha)
Update `docs/ENGINEERING_SNAPSHOT.md` before merging.
Add / update tests for every new route or breaking change.
Do not remove documented fields without version bump & contract update.

### FAST_TESTS Mode
CI default (`ci.yml`) runs with `FAST_TESTS=1` which:
- Uses fast migrations (minimal schema) to cut cold-start time.
- Skips or short-circuits heavy computations (signals bulk, some analytics).
- Certain long-running specs should guard with a skip when `FAST_TESTS=1` if they depend on full historical depth.
Nightly workflow (`nightly-full.yml`) runs with full migrations to catch drift. When adding new heavy tests, add a short comment & conditional skip pattern:
```
const fast = (globalThis as any).FAST_TESTS === '1' || (globalThis as any).__FAST_TESTS === '1';
const maybe = fast ? it.skip : it;
```
Prefer keeping logic deterministic & under 1s in fast mode.

## 12. License
Proprietary (decide OSS posture later).

---
For the fastest orientation read: ROADMAP → ARCHITECTURE → OPERATIONS_RUNBOOK.
