# PokeQuant — MVP Scope (Single-Owner Guardrails)

This file is the **source of truth** for our MVP. Anything marked ✅ must exist and must not regress.

## 0) Foundations
- ✅ Cloudflare Worker (TypeScript) + D1
- ✅ Nightly cron (UTC 10:00) to run pipeline
- ✅ GitHub Actions job to fetch Google Trends (SVI) and ingest to `/ingest/trends`
- ✅ Public Pages site with minimal UI

## 1) Data Ingestion
- ✅ **Universe**: curated rarities (Illustration/Special Illustration/Full Art/Promos etc.), excluding Japanese sets
- ✅ **Prices**: daily snapshots (USD preferred, EUR fallback)
- ✅ **SVI**: rolling Google Trends (90–365d), backfill, safe batching

## 2) Signal Engine
- ✅ Composite score using returns + vol + drawdown + regime + SVI z-score
- ✅ **SVI-only fallback** when price series is short (SVI ≥ 14)
- ✅ Store per-day **components** (`signal_components_daily`) for research and “Top Movers”

## 3) Public API (must not break)
- ✅ `GET /health`
- ✅ `GET /api/universe`
- ✅ `GET /api/cards`
- ✅ `GET /api/movers?n=24`
- ✅ `GET /api/card?id=<card_id>&days=<N>`
- ✅ `GET /research/card-csv?id=<card_id>&days=<N>`
- ✅ `POST /api/subscribe`
- ✅ Portfolio (MVP):
  - `POST /portfolio/create`
  - `POST /portfolio/add-lot` (headers: `x-portfolio-id`, `x-portfolio-secret`)
  - `GET  /portfolio` (same headers)
  - `GET  /portfolio/export` (same headers)
- ✅ Ingest (from GH Actions): `POST /ingest/trends` (header: `x-ingest-token`)
- ✅ Search endpoints: `/api/search`, `/api/sets`, `/api/rarities`, `/api/types`
- ✅ OpenAPI spec (`openapi.yaml`) kept in sync

> **Note:** Price alerts endpoints were prototyped earlier; we’ll formalize them after MVP core is locked.

## 4) UI (Pages)
- ✅ **Cards** table (signals if present, otherwise universe)
- ✅ **Top Movers** grid (ts7 momentum or fallback by score)
- ✅ Card details modal (sparklines + CSV download)
- ✅ Portfolio: create, add lot, P&L

## 5) Ops & Guardrails
- ✅ `docs/API_CONTRACT.md` kept in sync with code
- ✅ `scripts/smoke.sh` – hits prod endpoints
- ✅ CI: `.github/workflows/smoke.yml` runs on push to main
- ✅ PR template reminding to run smoke + update contract

## Discovery
- ✅ Top Movers (signals/components)
- ✅ Cards table (default signals if present, fallback to universe)
- ✅ **Search + Filter** (name/number/set/rarity/type) via `/api/search`, `/api/sets`, `/api/rarities`, `/api/types`

## Alerts
- ✅ Create price alerts (`/alerts/create`)
- ✅ One-click deactivate (`/alerts/deactivate?id=...&token=...`)
- ✅ Admin manual run `/admin/run-alerts` and automatic checks inside pipeline

## Portfolio
- ✅ Create portfolio, add lots, P&L summary

## Export/Research
- ✅ `/api/card` (detail) and `/research/card-csv` (download)

**Definition of Done for any change**
1. Contract updated (if endpoints/shape change).
2. Local `scripts/smoke.sh "$BASE"` passes.
3. CI smoke job passes after merge to `main`.

