## Runbook (Operator Quick Reference)

Area | Action | Command / Endpoint | Notes
---- | ------ | ------------------ | -----
Health | Basic liveness | GET /health | Returns 200 if worker initialized
Metrics | Human-readable | GET /admin/metrics | Admin token required
Metrics | Prometheus scrape | GET /admin/metrics-export | Format: text
Pipelines | Force cron run | (scheduled; manual composite via endpoints) | Cron triggers sequence nightly
Signals | On-demand compute | (cron only currently) | Add admin endpoint if needed
Alerts | Queue depth | GET /admin/alerts/stats | Examine backlog
Retention | Manual purge | Part of nightly | Add manual trigger later

### Incident Playbook
Symptom | Steps
------- | -----
High 5xx rate | Inspect `/admin/errors`, review recent deploy diff, roll back if needed.
Signals stale | Verify cron ran (pipeline_runs table), manually trigger compute if missing (TBD endpoint).
DB locked errors | Reduce parallel heavy endpoints; check long-running migrations.

### Rotation
Token rotation: redeploy with new ADMIN_TOKEN / INGEST_TOKEN (document schedule quarterly).

### Test Infrastructure Notes
Flaky transient error mitigation: a global patch wraps `SELF.fetch` in tests with up to 2 retries on the specific Cloudflare Workers transient error message `Network connection lost`. This reduced CI flakes without masking real failures.
Guidelines:
* Do not add custom retry loops in individual specs; ESLint rule `internal/no-ad-hoc-network-retry` warns on inline loops.
* To disable retry for a specific call (e.g., to assert failure timing), pass an option property `__retry:0` in the init object. Example: `await SELF.fetch(url, { __retry:0 });` (the property is stripped before dispatch).
* For extended retry scenarios (rare), use the helper `fetchRetry` in `test/util/fetchRetry.ts` and document rationale in the spec.
Coverage separation: UI (`vitest.ui.config.ts`) and a11y (`vitest.a11y.config.ts`) suites run in jsdom, excluded from the Workers pool run to avoid DOM and RNG restrictions.
