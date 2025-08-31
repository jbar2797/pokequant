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
