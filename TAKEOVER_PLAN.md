## Takeover Plan (Phase 0–Alpha)

Owner: Principal Engineer (App Studio)
Date: 2025-09-01
Status: Iteration 2

### 1. Repository & Stack Inventory
Component | Current | Target Delta
--------- | ------- | ------------
Runtime | Cloudflare Worker (TS, Modules) | Keep (add edge cache headers polish)
DB | Cloudflare D1 (SQLite) | Abstract; plan Postgres after Alpha
Tests | Vitest fast/full | Add provider swap & discord alert tests
CI | Actions (ci, nightly, smoke) | Release tagging + data dict drift gate (gate DONE)
Docs | docs/*.md partial | Core docs + automation complete (DONE)
Signals | Single module | Pluggable provider abstraction (DONE)
Frontend | Static pages | Next.js app scaffold (TODO)
Auth | Token headers (admin/ingest/portfolio) | OAuth/NextAuth later (post-Alpha)
Alerts | Email/webhook only | Discord webhook stub (DONE)
Observability | Metrics + export | Add tracing + Sentry later

### 2. Immediate Stabilization Tasks (Week 1)
- [x] CODEOWNERS
- [x] CONTRIBUTING.md
- [x] PR / issue templates
- [x] BLOCKERS.md
- [x] Data dictionary automation
- [x] API high-level doc
- [x] Signal engine interface
- [x] `.env.example` updates
- [x] Dashboard & watchlist endpoints
- [ ] Provider selection via dynamic import (scaffolded only)
- [ ] Discord alert end-to-end assertion test

### 3. Risks / Gaps
Area | Risk | Mitigation
-----|------|-----------
Schema Drift | Fast vs full migrations divergence | Drift script nightly + CI data dict gate
Signals Swap | Proprietary model integration risk | Stable provider interface & test harness
Rate Limiting | Burst bypass | Plan sliding window post-Alpha
Secrets Rotation | Manual tokens | Add rotation script & schedule
Vendor Lock | D1 limits at scale | DAL abstraction + migration plan

### 4. Alpha Feature Scope
Buy/Hold/Sell signals, portfolios, alerts (Discord stub), dashboard movers, search tiles, card detail.

### 5. Branch & PR Strategy
Prefixes: feat/fix/chore/docs/ci. <400 LOC per PR preferred.

### 6. Timeline (Projected)
Week 1: Stabilization, docs, signals abstraction (DONE)
Week 2: Schema refinement, seed demo dataset, Discord wiring test
Week 3: Dashboard aggregation endpoints, watchlist (DONE)
Week 4: Frontend scaffold + search tiles
Week 5: Card detail view + E2E tests
Week 6: Hardening & Alpha readiness review

### 7. Open Questions
Frontend monorepo vs separate? (lean monorepo)
Postgres timing? (Post-Alpha)
Licensing posture? (Pending legal)

### 8. Decision Log References
Use `.github/ISSUE_TEMPLATE/adr.md` for new ADRs.

### 9. Acceptance (Phase 0)
- CI green with data dictionary gate
- Pluggable signals provider in use
- Discord stub present
- Dashboard & watchlist endpoints live
- Docs baseline complete

---
Iteration 2: Added signals provider, discord stub, automated data dictionary, dashboard & watchlist.
