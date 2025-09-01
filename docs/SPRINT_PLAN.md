# Sprint Plan (Production Hardening Sprint 1)

Sprint Window: 2025-09-01 → 2025-09-14 (2 weeks)
Goal (Sprint Theme): Achieve beta-ready reliability & observability: real provider hooks, error & coverage guardrails fully enforced, core diagnostics surfaced, and minimal frontend foundation decision locked.

## Success Criteria (Exit)
- Real email provider integrated (send + bounce/complaint ingestion) behind feature flag; adapter abstraction stable.
- Webhook delivery signing spec finalized (canonical string + HMAC) & documented; feature flag for real dispatch implemented (not necessarily enabled in prod until keys provisioned).
- `/admin/errors` endpoint live (DONE) and referenced in runbook + dashboard story documented.
- Coverage ratchet enforced in CI (fails on regression) and baseline auto-update documented.
- Architecture / Ops docs updated for new error taxonomy & metrics (DONE).
- Decision record added for email provider selection.
- Minimal log redaction review performed; documented policy section.
- Frontend stack decision recorded (SvelteKit) + skeleton repo scaffolding ready (can be separate follow-up PR if outside this repo).

## Top-Level Epics
1. Email Provider Productionization
2. Webhook Real Dispatch & Signing
3. Coverage & Quality Gates Completion
4. Observability & Error Diagnostics
5. Rate Limit & SLO Refinements
6. Frontend Stack Decision

## Detailed Backlog

### 1. Email Provider Productionization
- [ ] Decision Record: choose Resend vs Postmark (criteria: API simplicity, bounce events, cost, DKIM ease).
- [ ] Implement provider adapter with send + parse inbound webhook (bounce, complaint) → persist to `email_deliveries` (status update) & increment metrics `email.bounced`, `email.complaint`.
- [ ] Feature flag `EMAIL_PROVIDER` env var; fallback to simulated when absent.
- [ ] Add bounce/complaint schema migration (table extension or new `email_events`).
- [ ] Update `API_CONTRACT.md` (admin listing includes bounce fields if present).
- [ ] Ops runbook: add bounce troubleshooting section.

### 2. Webhook Real Dispatch & Signing
- [ ] Decision Record: canonical signing string (JSON payload canonicalization? current plan: `timestamp + '.' + nonce + '.' + sha256(body)` ).
- [ ] Implement HMAC SHA256 with per-webhook secret; add `signature` header & existing `nonce` & `timestamp`.
- [ ] Feature flag `WEBHOOK_REAL=1` gate network egress; simulated mode increments `.simulated` metrics.
- [ ] Admin endpoint to rotate webhook secret (updates row, returns new secret once) + audit event.
- [ ] Metrics: `webhook.sent.real`, `webhook.error.real`, `webhook.retry_success.real`.
- [ ] Update OpenAPI + contract + runbook sections (redelivery + signature spec).

### 3. Coverage & Quality Gates Completion
- [ ] CI workflow: replace any legacy coverage step with `npm run coverage`.
- [ ] Add ratchet step failing on regression (tolerance 0.1) on PRs; allow manual override label or `--update` commit.
- [ ] Pre-commit hook (optional) to run quick coverage diff on changed lines (heuristic).
- [ ] Add badge auto-refresh in CI after successful merge (invoke `coverage:badge`).
- [ ] Extend ESLint rule: forbid `json({ ok:false, error:` patterns unless using `err()` (already enforced but add secondary check for missing metrics?).

### 4. Observability & Error Diagnostics
- [x] `/admin/errors` endpoint listing codes & counts.
- [ ] Add log field `error_code` when `err()` used (modify helper to log event `api_error` once per request optionally; guard by env flag to avoid noise).
- [ ] Dashboard doc draft (Grafana/Looker placeholder) mapping metrics → panels.
- [ ] Add metric `req.route.<slug>` counter (if not already) for cardinality baseline (verify; tests suggest present indirectly).
- [ ] Error aggregation test: inject synthetic errors; assert endpoint lists counts.

### 5. Rate Limit & SLO Refinements
- [ ] Expand rate limiting to any remaining public endpoints (verify sets/rarities/types already done; check research CSV & movers variants).
- [ ] Adaptive SLO tuning: add `GET /admin/slo/recommend` (computes 90th percentile latency last N requests; suggests threshold = p90 + 20%).
- [ ] SLO doc update referencing recommendation endpoint.
- [ ] Alerting stub: metric `slo.breach_ratio.route.<slug>` > threshold triggers log `slo_breach_alert` (future integration).

### 6. Frontend Stack Decision
- [ ] Decision Record: adopt SvelteKit + Tailwind (+ why not Next/ Astro).
- [ ] Create minimal SvelteKit scaffold (repo or subdir) with health fetch + ETag demo.
- [ ] Theming tokens file + dark mode toggle.
- [ ] Data client wrapper: conditional GET w/ ETag; simple cache layer.

## Stretch (Pull If Ahead)
- [ ] Structured log shipping design doc (targets, redaction rules, retention policy).
- [ ] Basic load test script (k6 or wrk) hitting core read endpoints; capture baseline p50/p95.
- [ ] `/admin/errors/export` Prometheus-style gauge per error code.

## Out of Scope (Defer)
- Billing & auth tiering.
- Multi-region replication.
- Advanced analytics collection.

## Risks & Mitigations
- Provider DNS (SPF/DKIM) delays → Start day 1, mock in staging while waiting.
- Signature mismatch bugs → Provide verification test vector in docs; include clock skew allowance.
- Coverage flakiness (dynamic lines) → Use tolerance, lock versions.
- Metric cardinality explosion (error codes) → Keep flat enum; avoid dynamic interpolation.

## Metrics to Track This Sprint
- Coverage baseline (lines/functions/branches) trend.
- Error code diversity (< 25 codes exercised in typical day; watch for accidental proliferation).
- SLO breach ratio for `api_universe`, `api_cards`, `api_search` (target <5%).
- Email delivery success rate (once real provider enabled).
- Webhook success / retry distribution.

## Daily Cadence
- Standup: status, blockers, next 1–2 tasks.
- Mid-sprint review (Day 7): provider integration & signing spec merged; adjust stretch goals.
- Retro: capture what simplified stabilization (guardrails) & doc any gaps.

## Tracking Notes
Use checklist updates in `ENGINEERING_SNAPSHOT.md` (Section 3a) as tasks complete; reference commit IDs.
