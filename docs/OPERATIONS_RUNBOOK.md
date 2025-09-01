# Operations Runbook

## 1. Nightly Pipeline Failure
Symptoms: Missing new prices/signals next day, alerts quiet, metrics gap.
Actions:
1. Check `/admin/metrics` for latest `pipeline.run` counters.
2. Manually trigger `/admin/run-now` (capture response timings).
3. Inspect logs for ingestion errors (future structured logs) / fallback to audit events.
4. If upstream price source down: mark incident, retry later; alerts may use last snapshot (document to users).

## 2. Migration Drift / Missing Table
Symptoms: 500 errors "no such table".
Actions:
1. Hit `/admin/migrations` to list applied.
2. If test or fresh environment: ensure `runMigrations` executed early; redeploy.
3. Never mutate existing migrations; append new.

## 3. Alert Delivery Issues
Symptoms: No recent email/webhook attempts.
Actions:
1. Check webhook deliveries table & email deliveries table via admin endpoints.
2. Examine retry counts & terminal error reasons.
3. For provider outage: queue persists; communicate partial degradation.

## 4. Performance Regression
Symptoms: Latency p95 spikes.
Actions:
1. `/admin/latency` for current p50/p95.
2. Identify top routes hit (future per-route metrics) – temporary: sample logs.
3. Profile: disable new feature toggles; compare.
4. Add index / rewrite heavy queries (avoid full scans inside hot endpoints).

## 5. Rate Limiting Complaints
## 5a. Elevated Error Rates
Symptoms: Spike in 4xx/5xx counters or specific error codes.
Actions:
1. Check `/admin/errors` for top error codes today (counts per `error.<code>` and `error_status.<family>`).
2. Correlate with `/admin/metrics` latency & SLO breach ratios. Rising 5xx often drives SLO breaches.
3. Drill into recent deploy diff for affected route modules.
4. Add temporary structured logging around suspected validation branch; redeploy; monitor reduction.

Symptoms: Users hitting 429 unexpectedly.
Actions:
1. Confirm configured limits (env vars, defaults).
2. Inspect `rate_limits` table entries for offender key.
3. Increase limit temporarily via redeploy or instruct user to batch requests.

## 6. Data Quality Warning
Symptoms: Factor z-scores extreme / SVI stale.
Actions:
1. Verify trends ingest job success (GitHub workflow logs).
2. Run incremental ingestion if missed days.
3. Recompute factors (`/admin/factor-returns/run`).

## 7. Portfolio Auth Issues
Symptoms: Users locked out after rotation.
Actions:
1. Confirm hashed secret stored; ensure header case-insensitive.
2. Provide user with generated new secret (cannot recover old plaintext).

## 8. Incident Communication Template
```
Incident: <summary>
Start: <UTC timestamp>
Impact: <services/endpoints affected>
User Impact: <plain explanation>
Mitigation: <steps taken>
ETA: <if ongoing>
Postmortem: scheduled <date>
```

## 9. Recovery Drill Checklist (Quarterly)
- Simulate missing migration in staging.
- Simulate upstream price outage (skip ingest for a day) – validate fallback messaging.
- Force webhook delivery failures (return 500) – confirm retries & metrics.

## 10. Pending Enhancements
- Structured logging for faster triage.
- Automatic alert if pipeline misses SLA window.
- Dashboard summarizing last pipeline phases durations.

## 11. SLO Monitoring & Tuning
Per-route dynamic latency SLOs provide an objective reliability bar.

Key Points:
- Default threshold 250ms unless overriden in `slo_config`.
- Admin endpoints: GET `/admin/slo`, POST `/admin/slo/set { route, threshold_ms }` (route can be full path or slug e.g. `/api/cards` → `api_cards`).
- Metrics: `req.slo.route.<slug>.good` vs `req.slo.route.<slug>.breach` (breach = latency >= threshold OR 5xx).
- Rolling breach ratio gauge: `slo.breach_ratio.route.<slug>` (integer = ratio * 1000 over last up to 100 requests). Divide by 1000 for human-readable value. Use for short-window alerting; pairs with aggregated long-horizon ratios in `/admin/metrics` `slo_ratios` object.
- Real-time debug: GET `/admin/slo/windows` returns current in-memory rolling window sample counts and breach ratios per route for low-latency triage (ephemeral; resets on deployment / isolate recycle).
- Aggregated ratios endpoint: `GET /admin/metrics` now includes `slo_ratios` object: `{ <slug>: { good, breach, breach_ratio } }` where `breach_ratio = breach / (good+breach)`.
- Target: keep `breach_ratio` < 0.05 for core read routes (`api_cards`, `api_universe`, `api_search`). Tighten thresholds once consistently < 0.02.
- Alert Budget: a 5% breach budget over rolling 30 days implies daily allowance ~1.67% if evenly distributed. Temporary spikes acceptable if weekly average stays < 3%.
- Recommended alerting:
	- WARN when 5‑minute breach_ratio > 7% and total samples > 50.
	- PAGE when 15‑minute breach_ratio > 10% OR 5‑minute > 15% (samples > 100) OR any sustained 5xx surge (>1% of requests) coincides with breach spike.
	- Short-window gauge trigger: if `slo.breach_ratio.route.api_cards` (value/1000) > 0.15 for > 3 consecutive scrapes (approx 1m) escalate to PAGE even if longer window not yet breached.
- Post-incident: capture top breaching routes via `slo_ratios` snapshot + latency bucket distribution (`/admin/latency-buckets`).
- Track breach ratio = breaches / (good+breach) over rolling windows (1h, 24h). Investigate if ratio > agreed target (e.g. 1-2%).
	- For very low-traffic routes (<25 samples) rely on longer consolidation or manual inspection; the rolling gauge window may be too noisy.
- Adjust threshold only after validating regression cause; do not raise threshold just to hide issues.
- Redelivery tool for webhooks: POST `/admin/webhooks/redeliver { delivery_id }` to replay a single failed (or even successful) payload after external fix.

### Error Taxonomy & Logging Redaction
- Stable error codes enumerated in `src/lib/errors.ts`; responses include `{ ok:false, error:<code> }` (tests assert specific codes for regression safety).
- Metrics automatically increment for standardized error paths via helper (in-progress full adoption) using pattern `error.<code>` & `error_status.<status>`.
- Basic log redaction masks field names containing `secret|token|password|apikey|auth` (case-insensitive) including shallow object properties. Review periodically for adequacy before introducing external log shipping.
