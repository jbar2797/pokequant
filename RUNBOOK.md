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
