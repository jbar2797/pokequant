# Roadmap (Alpha → Beta → GA)

Status Legend: ✅ done, 🚧 in progress, ⏭ planned, ❌ not started

## Phase 0 (Complete MVP Backend) – ✅
Core ingestion, signals, portfolio, alerts (simulated), search, caching, rate limits (subset), admin metrics.

## Phase 1 (Alpha Hardening) – Weeks 1–2
- 🚧 Real email provider integration (send + bounce webhook)
- 🚧 Webhook real delivery (config flag) + HMAC signature + timestamp + nonce doc
- ⏭ Error metrics expansion (req.error.4xx / req.error.5xx) & surfacing
- ⏭ Coverage badge & ratchet gate in CI
- ⏭ Architecture diagram & README alignment

## Phase 2 (Frontend Overhaul) – Weeks 2–3
- ⏭ Replace static pages with modern SPA/SSR (SvelteKit or Next.js static export)
- ⏭ Components: Cards table (sortable, filter), Movers grid w/ skeleton, Card detail modal with sparkline & download, Portfolio dashboard (lots + PnL, exposures, attribution)
- ⏭ Design system (tokens, dark mode, spacing scale) + responsive layout
- ⏭ Basic analytics (pageview + key action events) optional

## Phase 3 (Beta Readiness) – Weeks 4–6
- ⏭ Structured JSON logging + log correlation id
- ⏭ Rate limit expansion: all public endpoints & per-IP adaptive backoff
- ⏭ Runbook completion + incident drills (simulate ingestion failure, migration rollback)
- ⏭ User onboarding docs (API quickstart, portfolio examples)
- ⏭ Feedback capture channel (email/web form)
- ⏭ Data quality dashboards (stale prices, SVI gaps, factor z-score sanity)

## Phase 4 (Beta) – 30 Day Stability Window
- ⏭ Track pipeline success consecutive days (target 30/30)
- ⏭ Performance baseline (p50/p95 latency budgets documented)
- ⏭ Webhook & email delivery success SLIs
- ⏭ Alert accuracy sampling (spot checks vs expected thresholds)

## Phase 5 (GA Considerations)
- ⏭ Access tiering / auth tokens per user
- ⏭ Billing / quotas
- ⏭ Historical bulk export endpoints
- ⏭ Multi-region replication / failover strategy
- ⏭ Compliance review (PII minimal; email only)

## Cross-Cutting Enhancements
- Portfolio risk decomposition (factor vs residual)
- Materialized factor snapshot caching
- Benchmark methodology refinement
- Alert escalation levels / cooldowns

## Milestone Exit Criteria
Alpha → Beta: real providers active, frontend usable, error metrics + coverage ratchet, architecture & runbook docs complete.
Beta → GA: stability & performance targets met, user feedback integrated, no critical incidents in 30 days.
