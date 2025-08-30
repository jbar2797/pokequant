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
- 200 JSON: `{ ok, portfolio_id, lots: [...] }`

## `GET /api/sets`
- 200: `[ { v: string, n: number }, ... ]` (set name and count)
- Cache-Control: public, max-age=300
- ETag supported

## `GET /api/rarities`
- 200: `[ { v: string, n: number }, ... ]`
- Cache-Control: public, max-age=300
- ETag supported

## `GET /api/types`
- 200: `[ { v: string }, ... ]` (unique tokens from `cards.types`)
- Cache-Control: public, max-age=300
- ETag supported

## `GET /api/search?q=&set=&rarity=&type=&limit=&offset=`
- 200: `[{ id, name, set_name, rarity, image_url, signal?, score?, price_usd?, price_eur? }, ... ]`

## `POST /alerts/create`
- Body: `{ email, card_id, kind: 'price_below'|'price_above', threshold: number }`
- Internal storage column: `threshold_usd` (older deployments may have legacy `threshold`; runtime auto-detects)
- 200: `{ ok: true, id, manage_token, manage_url }`
- Error examples: `{ ok:false, error:'email_and_card_id_required' }`, `{ ok:false, error:'threshold_invalid' }`

## `GET|POST /alerts/deactivate`
- 200: `{ ok: true }` (POST) or small HTML confirmation (GET)
- Error examples: `{ ok:false, error:'id_and_token_required' }`, `{ ok:false, error:'invalid_token' }`

## Ingest — GitHub Action only
## Specification
An OpenAPI 3.1 document is maintained at `/openapi.yaml` in the repository root. Clients should prefer that for generation; this markdown is a human summary.

### `POST /ingest/trends`
- Header: `x-ingest-token`
- Body: `{ rows: [{ card_id, as_of(YYYY-MM-DD), svi(int) }, ...] }`
- 200 JSON: `{ ok: true, rows: <inserted> }`

## Admin Endpoints (require `x-admin-token`)

### `GET /admin/metrics`
- Returns last 3 days of internal counters plus latency summary:
	`{ ok:true, rows:[{ d, metric, count }, ...], latency:[{ d, base_metric, p50_ms, p95_ms }, ...] }`
	- Latency metrics recorded as exponential moving estimates; early values stabilize after several requests.

### `GET /admin/latency`
- Latest (single snapshot) latency per tag only: `{ ok:true, rows:[{ base_metric, p50_ms, p95_ms }, ...] }`

### `POST /admin/run-alerts`
- Manually evaluate alert rules without recomputing signals.
- 200: `{ ok:true, checked:<n>, fired:<m> }`

### `POST /admin/run-fast`
- Recompute signals only (no upstream card fetch). 200: `{ ok:true, idsProcessed, wroteSignals }`

### `POST /admin/run-now`
- Full pipeline: fetch universe, snapshot prices, compute signals, run alerts.
- 200: `{ ok:true, pricesForToday, signalsForToday, bulk:{...}, alerts:{...}, timingsMs:{...} }`

### `GET /admin/diag`
- Diagnostics summary of coverage (counts of cards with sufficient history).

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
- `POST /admin/backtests`: run spread backtest (params: lookbackDays, txCostBps, slippageBps)
- `GET /admin/backtests`: list recent backtests
- `GET /admin/backtests/{id}`: backtest detail with equity curve

### Audit & Integrity (earlier versions, expanded)
- `GET /admin/audit`: list mutation audit events (filters: resource, action, actor_type, resource_id, limit, before_ts)
- `GET /admin/audit/stats`: summary counts over trailing hours window (param: hours)
- `GET /admin/integrity`: dataset coverage & freshness snapshot

### Factor Configuration & Weights
- `GET /admin/factors`, `POST /admin/factors`, `POST /admin/factors/toggle`, `POST /admin/factors/delete`
- `GET /admin/factor-weights`, `POST /admin/factor-weights` (bulk upsert), `POST /admin/factor-weights/auto`

### Ingestion & Provenance
- `POST /admin/ingest/prices`: mock external ingestion
- `POST /admin/ingestion/config` / `GET /admin/ingestion/config`: config rows
- `POST /admin/ingestion/run`: run incremental ingestion across enabled configs
- `GET /admin/ingestion/provenance`: ingestion provenance listing (filters)

### Misc
- `GET /admin/factor-correlations`: (legacy path) rolling correlation matrix (superseded by /admin/factor-risk)
- `GET /admin/snapshot`: consolidated snapshot (integrity, factor_ic, active_weights, factor_returns)

## Portfolio Analytics (Non-admin)
### `GET /portfolio/exposure`
- Auth headers: `x-portfolio-id`, `x-portfolio-secret`; returns latest factor exposure averages.
### `GET /portfolio/exposure/history`
- Historical exposure snapshots.
### `GET /portfolio/attribution`
- Factor vs residual attribution for portfolio returns.
### `GET /portfolio/pnl`
- Daily portfolio returns (ret) & realized components (ret, turnover_cost, realized_pnl), optional `days` (<=180).

## Rate Limiting

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
