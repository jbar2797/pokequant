## Takeover Plan (Phase 0–Alpha)

Owner: Principal Engineer (App Studio)
Date: 2025-09-01
Status: Draft (iteration 1)

### 1. Repository & Stack Inventory
Component | Current | Target Delta
--------- | ------- | ------------
Runtime | Cloudflare Worker (TS, Modules) | Keep (add edge cache headers polish)
DB | Cloudflare D1 (SQLite) | Migrate to Postgres (alpha keeps D1) — introduce DAL abstraction
Tests | Vitest + custom fast/full modes | Keep; add e2e (Playwright or API-level) later
CI | GitHub Actions (ci.yml, nightly-full, smoke) | Add release tagging + conventional commits gate
Docs | Multiple markdown under docs/ | Normalize + add missing (DATA_DICTIONARY, API, CONTRIBUTING, RUNBOOK)
Signals | Custom in `lib/signals.ts` | Introduce pluggable provider interface (`signals/` dir)
Frontend | Static pages (public/) | New Next.js app (separate repo or /app) – TBD alpha stub
Auth | Token headers (admin/ingest/portfolio) | Plan OAuth / NextAuth for web; keep headers for system tokens
Alerts | Email/webhook simulated | Integrate Discord + real email (Resend) – feature flags
Observability | Metrics tables + JSON logs | Add tracing (OpenTelemetry shim) + Sentry later

### 2. Immediate Stabilization Tasks (Week 1)
- [ ] Add CODEOWNERS
- [ ] Add CONTRIBUTING.md (internal standards, commit message style)
- [ ] Add PR template & issue templates (bug/feature/tech debt)
- [ ] Create BLOCKERS.md
- [ ] Add DATA_DICTIONARY.md (seed from schema & migrations)
- [ ] Add API.md (higher level than openapi.yaml)
- [ ] Extract signal engine interface
- [ ] Add `.env.example` completeness pass
- [ ] Tighten ESLint (imports ordering, unused vars) add CI gate for formatting

### 3. Risks / Gaps
Area | Risk | Mitigation
-----|------|-----------
Schema Drift | Fast vs full migrations divergence | Add schema drift check (already script) to nightly, enforce on CI for PRs touching migrations
Signals Complexity | Proprietary model swap risk | Interface boundary + regression harness w/ golden cards
Rate Limiting | Simple fixed-window may allow bursts | Consider sliding window + token bucket once traffic increases
Secrets Rotation | Manual for admin/ingest tokens | Add rotation script + doc, move to GitHub Actions secret rotation quarterly
Vendor Lock (D1) | Scale / SQL feature limits | Abstract DB layer; plan Postgres migration w/ drizzle or prisma generator

### 4. Alpha Feature Scope (Confirm)
See README & user request: buy/hold/sell signals, portfolios, alerts (Discord), dashboard movers, search tiles, card detail.

### 5. Branch & PR Strategy
Branch naming: `chore/*`, `feat/*`, `fix/*`, `docs/*`, `ci/*`.
Small atomic PRs (<400 LOC diff) with checklist referencing Alpha Gate.

### 6. Workstream Timeline (Projected)
Week | Focus
---- | -----
1 | Stabilization + docs + signal interface extraction
2 | Schema refinement + data dictionary + seed dataset & demo cards
3 | Alerts (Discord), portfolio/watchlist polish, dashboard API bundling
4 | Frontend scaffolding (Next.js) + search tiles + card detail mocks
5 | E2E tests, security headers, rate limit tuning
6 | Alpha hardening & Beta planning doc

### 7. Open Questions
1. Frontend repo split vs monorepo? (default: monorepo /apps/web)
2. Postgres timeline — before Beta or after? (lean: after Beta once workloads defined)
3. Licensing OSS or closed? (Need legal input)

### 8. Decision Log References
See `docs/DECISIONS/` – add new entries for: DB abstraction, signal provider boundary, frontend framework selection.

### 9. Acceptance for This Phase (Done Definition)
- Core CI green; new docs present
- Signal provider interface stub merged & used by cron
- Data dictionary generated & validated in CI
- Blockers documented with owners

---
Iteration history will be appended below.
