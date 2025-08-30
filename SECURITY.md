## Security Overview

MVP hardens basic access through simple header tokens and capability secrets.

### Tokens & Headers

| Purpose | Header | Source | Scope |
|---------|--------|--------|-------|
| Admin API | `x-admin-token` | ENV `ADMIN_TOKEN` | All `/admin/*` (except public health) |
| Ingestion mock | `x-ingest-token` | ENV `INGEST_TOKEN` | `/admin/ingest/prices` |
| Portfolio auth | `x-portfolio-id` + `x-portfolio-secret` | Generated on `/portfolio/create` | Portfolio-scoped endpoints |

Secrets are transmitted only over HTTPS (Cloudflare edge). No persistence of admin tokens beyond environment variable; rotate by updating Worker vars and redeploying.

### Portfolio Capability Model

`/portfolio/create` generates a random 128-bit hex secret (32 chars). The secret is stored server-side and must accompany the portfolio id. Leakage of the secret grants read/write to that portfolio only; rotate by creating a new portfolio and migrating lots (future enhancement: secret rotation endpoint).

### Rate Limiting

Basic in-memory (per worker instance) counters with env-configurable overrides guards public endpoints (search, subscribe, alert create). For production multi-pop consistency consider durable coordination (KV / Durable Objects).

### Retention Controls

Retention endpoint allows on-demand purge of historical tables; override windows via env `RETENTION_<TABLE>_DAYS` or request body windows map.

### Future Hardening Ideas

- HMAC-signed portfolio JWT to remove server-side secret comparison.
- Admin token rotation schedule & audit log for token usage.
- Structured RBAC for ingestion vs analytics roles.
- Hash portfolio secrets at rest (salted) instead of plaintext.
- Per-endpoint rate limit buckets & exponential backoff for abuse.

### Reporting

Report security issues privately via repository owner contact; avoid filing public issues with exploit details.
