# Production Readiness Assessment

Last Evaluated: 2025-09-02T12:05:00Z
Overall Score: **73%** (Target for Beta: 75–80%)

## Dimension Breakdown
| Dimension | Score | Rationale | Key Gaps |
|-----------|-------|-----------|----------|
| Functional Coverage | 82% | All MVP + analytics endpoints; delivered metric now event‑sourced | Real webhook outbound dispatch (real mode), provider error taxonomy |
| Observability & Telemetry | 75% | Latency (p50/p95), buckets, SLO breach metrics, per-error codes, retention health, success ratios, split email metrics, taxonomy gauges, external log sink scaffold + flush endpoint | External log sink retries/backoff, richer tracing/export, dashboard doc |
| Reliability / Resilience | 60% | Idempotent migrations, webhook retry/backoff, anomaly detection, retention purges | Single-region DB, no failover, limited circuit breaking |
| Delivery Integrations | 70% | Delivered webhook secured + rotation (NEXT secret) support, diagnostics rotation state, provider error taxonomy emitted via metrics (pq_email_error_codes) | Domain auth DNS (SPF/DKIM/DMARC) rollout, real outbound webhook enablement, provider bounce classification expansion |
| Security & Guardrails | 71% | As before + webhook secret rotation dual-secret acceptance, external log sink scaffold (R2 mode) | No RBAC tiers, no automated rotation tooling, deeper audit coverage |
| Test & Quality Gates | 80% | 146 tests, coverage ratchet enforced in CI workflow, badge generation | Mutation testing (optional), flaky test sentinel, baseline coverage trending doc |
| Frontend UX | 45% | SPA Phase 2 (hash router, cards/movers panels, modal detail, initial a11y focus) | SWR revalidation layer, portfolio & alerts UI, perf budget & accessibility audit |

## Immediate Priority Actions (Raise Score Fast)
1. Real webhook outbound (enable flag in staging → prod) + finalize signing verification docs & add metrics split validation.
2. External log sink harden (flush tests, retry/backoff, failure counters) & redaction tests expansion.
3. Domain email auth (SPF, DKIM, DMARC) execution + verification endpoints/metrics.
4. SPA Phase 3: portfolio lots read UI completion, alerts create UI, global SWR adoption, performance budgets, a11y audit.
5. Taxonomy anomaly alerts (threshold on email_provider_rate_limited & email_invalid_recipient) + expand provider mapping with live samples.

## Secondary Actions
 External logs shipping (R2 or third-party) + expanded redaction test.
 Architecture diagram refresh & README alignment.

## Risk Register (Top 5)
| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| Single-region D1 outage | Full API downtime | Medium | Document RTO, plan read-replica strategy post-Beta |
| Email/webhook integration delay | Delays Beta readiness | Medium | Start provider DNS immediately, keep simulation fallback |
| Coverage regression unnoticed | Hidden reliability drift | Low | Add ratchet gate + daily coverage trend badge |
| Log noise / sensitive field leakage when shipping externally | Compliance / data exposure | Low | Strengthen redaction patterns + add test harness |
| Residual test flake resurfacing | CI noise, slower iteration | Low | Shared retry helper & readiness probe escalation |

## Monitoring & Alerting Baselines
- Core API SLO breach ratio (<5% primary routes).
- Webhook/email delivery success ratio (>95% once real).
- Daily pipeline success (target 30/30 pre-GA).

## Decision Follow-Ups
- Email provider decision record (Resolved: Resend, Decision 0005).
- Webhook signing spec decision (documented) – next enable real mode & rotation runbook.
- Coverage ratchet strategy locked (fail regressions, update baseline on improvements).
- SWR caching strategy (pending) – adopt stale-while-revalidate layer client‑side.

## Exit Criteria Toward Beta (Delta)
- [+] Real delivery integrations active.
- [+] Coverage ratchet enforced.
- [+] SPA skeleton merged.
- [+] Runbook updated with provider + webhook operational steps.

---
Update this file whenever readiness score changes ≥ 5% or after any major integration lands.

## Recent Additions (Wave 1 Enhancements)
- Expanded idempotency: alerts (create, deactivate, snooze) and portfolio mutations (add/update/delete lot, targets, orders create/execute).
- Circuit breaker integrated for webhook + email outbound with transition metrics (`breaker.open`, `breaker.reopen`, `breaker.close`).
- Structured log sink modes (`r2`, `http`, `memory`) with metrics (`log.flush`, `log.flush_error`, `log.flush_retry`) and admin endpoints (`/admin/logs/flush`, `/admin/logs/stats`).
- Admin token rotation helper endpoint (`POST /admin/security/rotate-admin-token`).
- Half-open breaker behavior validated via unit tests with simulated time advance.
