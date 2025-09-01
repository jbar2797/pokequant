# Architecture

```mermaid
graph LR
  subgraph Ingestion
    A[GitHub Action\nTrends Fetch] -->|POST /ingest/trends| W
    Cron[Nightly Cron] -->|Universe + Prices + Signals| W
  end
  W[Cloudflare Worker] --> D[(D1 SQLite)]
  UserBrowser -->|HTTPS (public)| W
  AdminUser -->|Admin Token| W
  W -->|ETag'd JSON| UserBrowser
  subgraph Alerts
    W --> AL[Alerts Eval]
    AL --> EM[Email Sim/Provider]
    AL --> WH[Webhook Dispatcher]
  end
  WH --> ExtWebhook[External Endpoints]
  EM --> Mailboxes
```

## Components
- Worker Runtime: request router + route modules under `src/routes` lazy-loaded at import time.
- Database: D1 (SQLite) single-region; migrations recorded in `migrations_applied`.
- Pipeline: cron triggers full ingestion & signal compute; can be invoked manually (`/admin/run-now`).
- Metrics: stored in `metrics_daily` with exponential moving percentiles for latency.
- Alerts: price threshold alerts with retry/backoff; simulated email & webhook currently.
- Webhooks: queued deliveries, signature (planned HMAC) + nonce replay protection.
- Portfolio: hashed secrets, lots, PnL, exposures, attribution.

## Data Flow (Nightly)
1. Universe update (cards metadata)
2. Price snapshot
3. Trends ingest (scheduled job earlier / on demand)
4. Signal components compute → signal scores
5. Factor analytics (returns, risk, IC, performance, smoothing)
6. Portfolio benchmark & exposures snapshot
7. Alerts evaluation + dispatch (simulated)
8. Retention & anomaly detection

## Caching Strategy
- Public list endpoints: short TTL + strong ETag (re-compute signature hash from base data).
- Avoid long CDN cache due to rapid iteration in alpha.

## Resilience
- Idempotent migrations; on-demand integrity probe triggers replay for fresh test DBs.
- Alerts + ingestion operations inside try/catch with metrics on failures.

## Observability
Implemented:
* Structured JSON logging with correlation IDs (`x-request-id`) automatically propagated (see `src/lib/log.ts`) and basic redaction of sensitive field names.
* Request metrics: per-route counters, status family counters, latency EMAs (p50/p95), latency bucket counters.
* Dynamic per-route SLO classification metrics with rolling breach ratio gauge.
* Alert, email, webhook, retention purge, and ingestion job metrics.
* Per-error code & HTTP status family counters (`error.<code>`, `error_status.<status>`), enumerated centrally in `src/lib/errors.ts` via the `err()` helper.
* Admin diagnostics endpoints: `/admin/metrics`, `/admin/latency`, `/admin/latency-buckets`, `/admin/metrics/export` (Prometheus), and `/admin/errors` (lists all known error codes with current counts).

Planned / Future:
* Aggregated dashboard (external) consuming Prometheus export.
* Structured log shipping adapter (R2 or external collector) + enhanced redaction policy.
* Multi-region read replicas (post-GA) with eventual consistency strategy.

### Dynamic Per-Route SLOs
- Table `slo_config(route TEXT PRIMARY KEY, threshold_ms INTEGER, updated_at TEXT)` defines latency SLO thresholds per normalized route slug (e.g. `/api/cards` → `api_cards`).
- Default threshold 250ms if unset; admin can GET `/admin/slo` and POST `/admin/slo/set { route, threshold_ms }` (route may be path or slug).
- Router fetches threshold (cached 30s) and emits classification metrics: `req.slo.route.<slug>.good|breach` (breach on latency >= threshold or any 5xx).
- Latency histograms: `latbucket.route.<slug>.<bucket>` with buckets lt50/lt100/lt250/lt500/lt1000/gte1000.

### Webhook Redelivery
- Admin endpoint `/admin/webhooks/redeliver` performs a single immediate replay of a prior delivery (body: `{ delivery_id }`).
- Creates new `webhook_deliveries` row with `redeliver=1`, fresh nonce/signature (if secret) and attempt=1 (separate from original attempts sequence).
- Metrics: `webhook.redeliver.sent(.real)` or `webhook.redeliver.error(.real)` parallel existing send namespaces.
- Use-case: manual out-of-band replay after fixing an external receiver issue without waiting for automated retry window (original retries limited to 3 attempts with exponential backoff + jitter).
