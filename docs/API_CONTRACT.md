# API Contract (MVP)

This is the **minimal shape** clients can rely on. Adding fields is OK; removing/renaming is a breaking change.

## `GET /health`
- 200 JSON: `{ ok: boolean, counts: {...}, latest: {...} }`

## `GET /api/universe`
- 200 JSON: `[{ id, name, set_name, rarity, image_url, price_usd?, price_eur? }, ...]`
- Size ≤ 250

## `GET /api/cards`
- 200 JSON: same shape as universe plus `{ signal, score }`
- Only rows with current signals (can be 0 early on)

## `GET /api/movers?n=<int>`
- 200 JSON: subset of cards with `{ ts7?, z_svi?, score }`
- Ordered by `ts7 DESC, score DESC`

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

## Ingest — GitHub Action only
### `POST /ingest/trends`
- Header: `x-ingest-token`
- Body: `{ rows: [{ card_id, as_of(YYYY-MM-DD), svi(int) }, ...] }`
- 200 JSON: `{ ok: true, rows: <inserted> }`
