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

## Planned Improvements
- Structured logging (JSON) with request_id
- Per-route error counters / dashboards
- Multi-region read replicas (post-GA)
