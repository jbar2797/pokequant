# API Contract (MVP)

This is the **minimal shape** clients can rely on. Adding fields is OK; removing/renaming is a breaking change.

## `GET /health`
- 200 JSON: `{ ok: boolean, counts: {...}, latest: {...} }`

## `GET /api/universe`
- 200 JSON: `[{ id, name, set_name, rarity, image_url, price_usd?, price_eur? }, ...]`
- Size ≤ 250
- Cache-Control: public, max-age=60
- ETag supported (If-None-Match => 304)

## `GET /api/cards`
- 200 JSON: same shape as universe plus `{ signal, score }`
- Only rows with current signals (can be 0 early on)
- Cache-Control: public, max-age=30
- ETag supported

## `GET /api/movers?n=<int>`
- 200 JSON: subset of cards with `{ ts7?, z_svi?, score }`
- Ordered by `ts7 DESC, score DESC`
- Cache-Control: public, max-age=30
- ETag supported

## `GET /api/card?id=<card_id>&days=<N>`
- 200 JSON: `{ ok, card, prices:[{d, usd?, eur?}], svi:[{d, svi}], signals:[{d, signal, score, edge_z, exp_ret, exp_sd}], components:[{d, ts7, ts30, dd, vol, z_svi, regime_break}] }`

## `GET /research/card-csv?id=<card_id>&days=<N>`
- 200 CSV: columns `date,price_usd,price_eur,svi,signal,score,edge_z,exp_ret,exp_sd,ts7,ts30,dd,vol,z_svi`

## `POST /api/subscribe`
- Body: `{ email }`
- 200 JSON: `{ ok: true }`

## Portfolio
### `POST /portfolio/create`
- 200 JSON: `{ id, secret }` (secret only shown once)

### `POST /portfolio/add-lot`
- Headers: `x-portfolio-id`, `x-portfolio-secret`
- Body: `{ card_id, qty > 0, cost_usd >= 0, acquired_at? }`
- 200 JSON: `{ ok: true, lot_id }`

### `GET /portfolio`
- Headers: as above
- 200 JSON: `{ ok, totals: {...}, rows: [...] }`

### `GET /portfolio/export`
- Headers: as above

## `GET /api/sets`
- 200: `[ { v: string, n: number }, ... ]` (set name and count)
- Cache-Control: public, max-age=300

## `GET /api/rarities`
- 200: `[ { v: string, n: number }, ... ]`
- Cache-Control: public, max-age=300
- Cache-Control: public, max-age=300
- ETag supported

- `POST /admin/token-usage/purge` body: `{ days?: number }` (default 90, min 1, max 365) deletes records whose last_used_at is older than now - days. Response `{ ok:true, purged_days, changes }`.
## `POST /alerts/create`
- Body: `{ email, card_id, kind: 'price_below'|'price_above', threshold: number }`
- Error examples: `{ ok:false, error:'email_and_card_id_required' }`, `{ ok:false, error:'threshold_invalid' }`

## `GET|POST /alerts/deactivate`
## Specification
An OpenAPI 3.1 document is maintained at `/openapi.yaml` in the repository root. Clients should prefer that for generation; this markdown is a human summary.

### `POST /ingest/trends`
- Header: `x-ingest-token`
- Body: `{ rows: [{ card_id, as_of(YYYY-MM-DD), svi(int) }, ...] }`
- 200 JSON: `{ ok: true, rows: <inserted> }`

### `GET /admin/metrics`
- Returns last 3 days of internal counters plus latency summary:
	`{ ok:true, rows:[{ d, metric, count }, ...], latency:[{ d, base_metric, p50_ms, p95_ms }, ...] }`
	- Latency metrics recorded as exponential moving estimates; early values stabilize after several requests.
### `GET /admin/latency`
- Latest (single snapshot) latency per tag only: `{ ok:true, rows:[{ base_metric, p50_ms, p95_ms }, ...] }`

### `GET /admin/logs/recent` (NEW)
- Query param: `?limit=<n>` (default 100, max 500)
- 200: `{ ok:true, logs:[{ t, event, ...context }, ...], count }`

### `GET /admin/token-usage` (NEW)
- Fingerprint = first 128 bits (32 hex chars) of SHA-256(token). Raw token never persisted.
- Use during rotation to ensure new token adoption before revoking old.
- Future evolution: streamed full export to durable storage (R2) instead of inline JSON.
 - `GET /admin/backup/list`: last 50 snapshots `{ ok:true, rows:[{ id, created_at, meta, size }, ...] }`.
 - `GET /admin/backup/get?id=<id>`: fetch single backup `{ ok:true, backup:{ id, created_at, meta, data } }`.
 - Planned: per-route SLO burn gauges (currently accessible via JSON `/admin/slo/burn`).
 - `pq_slo_burn{route="<slug>"}` (gauge): daily burn ratio (breach/(good+breach)) per route (now emitted). Use for error budget alerting.
 - `anomaly_slo_burn` (counter via metrics_daily as `anomaly.slo_burn`): increments when automated SLO burn evaluation opens a new anomaly (one per route/day above threshold).

### `POST /admin/run-fast`
- Recompute signals only (no upstream card fetch). 200: `{ ok:true, idsProcessed, wroteSignals }`

### `POST /admin/run-now`
- Full pipeline: fetch universe, snapshot prices, compute signals, run alerts.
- 200: `{ ok:true, pricesForToday, signalsForToday, bulk:{...}, alerts:{...}, timingsMs:{...} }`

### `GET /admin/migrations`
- Lists applied migrations: `{ ok:true, rows:[{ id, applied_at, description }, ...] }`

### `GET /admin/version`
- Returns deployment version: `{ ok:true, version }`

### Factor & Portfolio Analytics (v0.5.17)
- `GET /admin/factor-returns`: latest factor returns (with rolling aggregates described in OpenAPI path description)
- `POST /admin/factor-returns/run`: force recompute latest day factor returns
- `GET /admin/factor-performance`: consolidated returns + IC + suggested weights
- `GET /admin/factor-risk`: pairwise covariance & correlation (rolling window)
- `GET /admin/factor-metrics`: per-factor volatility & beta snapshot
- `GET /admin/factor-returns-smoothed`: Bayesian-smoothed returns per factor
- `GET /admin/signal-quality`: IC stability metrics (mean, vol, lag1 autocorr, half-life)
- `GET /admin/portfolio-pnl`: portfolio daily PnL (ret, turnover_cost, realized_pnl)
- `POST /admin/portfolio-exposure/snapshot`: snapshot exposures for latest components day
- `POST /admin/portfolio-nav/snapshot`: snapshot portfolio NAV

### Backtests
### Webhooks (Admin)
- `GET /admin/webhooks` list endpoints.
- `POST /admin/webhooks` create endpoint `{ url, secret? }`.
- `POST /admin/webhooks/delete` delete by `{ id }`.
- `POST /admin/webhooks/rotate-secret` rotate secret and return new `{ secret }` once.
- `GET /admin/webhooks/deliveries` list recent deliveries (add `?include=payload` to include raw JSON payload for signature debugging).
### Error Logging
If env `API_ERROR_LOG=1` each standardized error response logs a single `api_error` structured log per request with `{ code, status }` (deduplicated). Metrics still emitted regardless.
```
<timestamp>.<nonce>.<sha256_hex_of_raw_body>
- `X-Webhook-Timestamp`: UNIX seconds
- `X-Webhook-Nonce`: UUID v4 without dashes
#### Verifying Signatures (Consumer Examples)
Canonical string: `<timestamp>.<nonce>.<sha256_hex_of_raw_body>`.
```
const crypto = require('crypto');
function verify(secret, ts, nonce, rawBody, signature){
	const canonical = `${ts}.${nonce}.${bodyHash}`;
	return expected.length===signature.length && crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(signature,'hex'));
```
```
import hmac, hashlib
def verify(secret: str, ts: str, nonce: str, raw_body: bytes, signature: str) -> bool:
		body_hash = hashlib.sha256(raw_body).hexdigest()
		canonical = f"{ts}.{nonce}.{body_hash}"
		expected = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
		return hmac.compare_digest(expected, signature)
- `POST /admin/backtests`: run spread backtest (params: lookbackDays, txCostBps, slippageBps)
- `GET /admin/backtests`: list recent backtests
- `GET /admin/audit`: list mutation audit events (filters: resource, action, actor_type, resource_id, limit, before_ts)
- `GET /admin/audit/stats`: summary counts over trailing hours window (param: hours)
### Factor Configuration & Weights
- `GET /admin/factors`, `POST /admin/factors`, `POST /admin/factors/toggle`, `POST /admin/factors/delete`
- `POST /admin/ingest/prices`: mock external ingestion
- `POST /admin/ingestion/config` / `GET /admin/ingestion/config`: config rows
- `POST /admin/ingestion/run`: run incremental ingestion across enabled configs
### Misc
- `GET /admin/factor-correlations`: (legacy path) rolling correlation matrix (superseded by /admin/factor-risk)
- `GET /admin/snapshot`: consolidated snapshot (integrity, factor_ic, active_weights, factor_returns)

## Portfolio Analytics (Non-admin)
- Historical exposure snapshots.
### `GET /portfolio/attribution`
- Daily portfolio returns (ret) & realized components (ret, turnover_cost, realized_pnl), optional `days` (<=180).

Administrative controls for per-route latency objectives.


### `POST /admin/slo/set`
- Body: `{ route, threshold_ms }` where `route` may be full path or slug. Threshold range 10–30000 ms.
- 200: `{ ok:true, rows:[{ route, current_threshold_ms, p95_ms, breach_ratio, suggested_threshold_ms, action, rationale }, ...] }`
- Heuristic actions: `raise`, `tighten`, or `keep`.

### Metrics
- Good vs breach counters: `req.slo.route.<slug>.good` and `req.slo.route.<slug>.breach` (breach when latency >= threshold OR 5xx status).
- Exported via Prometheus endpoint: `/admin/metrics/export` (`pq_metric{name="req_slo_route_<slug>_good"} <count>`).
- Use ratio breach/(good+breach) to gauge compliance.
 - Shortcut: `GET /admin/slo/burn` returns current-day JSON burn snapshot without scraping raw metrics export.
 - `GET /admin/slo/windows` returns short-window in-memory breach ratios (last up to 100 recent requests per route, resets on deploy) plus daily burn snapshot: `{ ok:true, windows:{ route:{ samples, breaches, ratio } }, daily:{ <burn snapshot> } }`.

### Tuning Guidance
- Start with 250ms default; tighten high-traffic read endpoints (<150ms) once stable.
- Breach budget alerts should trigger when rolling 5–10 minute breach ratio exceeds target SLO (e.g. >5%).

## Caching & Validation
Public read-mostly endpoints send short-lived Cache-Control headers (see individual sections).

Validation model:
- Strong ETag per logical dataset variant (base data signature + endpoint tag)
- Clients SHOULD cache 200 responses with their ETag and use `If-None-Match` on subsequent requests until local TTL expires; a 304 response reuses cached body.
- 304 responses still count toward latency metrics and increment cache hit counters (`cache.hit.*`).

Response headers (public cacheable endpoints):
- `Cache-Control`: short max-age (30–300s)
- `ETag`: strong validator

Fixed-window counters stored in `rate_limits` D1 table. Defaults:
- Search: 30 / 5 minutes per IP
- Subscribe: 5 / day per IP
- Alert create: 10 / day per IP+email

Override via environment variables (Wrangler vars):
- `RL_SEARCH_LIMIT`, `RL_SEARCH_WINDOW_SEC`
- `RL_SUBSCRIBE_LIMIT`, `RL_SUBSCRIBE_WINDOW_SEC`
- `RL_ALERT_CREATE_LIMIT`, `RL_ALERT_CREATE_WINDOW_SEC`

Exceeded requests return HTTP 429 and body: `{ ok:false, error:'rate_limited', retry_after:<seconds> }`.
Rate limit response headers (all rate-limited endpoints):
- `X-RateLimit-Limit`: total requests allowed in window
- `X-RateLimit-Remaining`: remaining requests (0 when next would be limited)
- `X-RateLimit-Reset`: epoch seconds when the window resets
- `Retry-After`: (only on 429) seconds until reset

## Recent Enhancements
- `/admin/slo/windows` now includes:
	- In-memory short-window ratios (last ~100 classified requests per route)
	- Persisted 60m aggregation (`persisted_60m`) sourced from `slo_breach_minute` table
	- Daily burn snapshot (aggregated good/breach counters)
- Per-minute SLO breach persistence: `slo_breach_minute (route, minute, total, breach)` enabling retro inspection & durable short-window aggregates.
- Backups: gzip compression + 500KB inline size cap; optional R2 push (`BACKUP_R2=1`) adds `r2_key` in meta; integrity regression fixed (0.8.4).
- SLO burn alerts: email to `ADMIN_ALERT_EMAIL` (if set) and signed webhook event `slo_burn.alert` (HMAC SHA-256 of canonical string `ts.nonce.sha256(body)`), retries (up to 3, exp backoff) on simulated path; real dispatch gated by `WEBHOOK_REAL_SEND=1`.
	- Webhook headers (new): `x-webhook-signature`, `x-webhook-timestamp`, `x-webhook-nonce` (+ legacy `x-signature*` transitional headers).
- Rate limit stats: `/admin/rate-limit/stats` anonymizes keys by default (hash) with `?raw=1` to reveal underlying keys.
- Automatic retention: config-driven purges for anomalies, backups, per-minute SLO breaches; defaults seeded (30d anomalies/backups, 2d slo_breach_minute).
- Retention health: `/admin/retention/health` returns config + row/minute counts + oldest timestamps; metrics `retention.age.<table>.days` gauges emitted.
