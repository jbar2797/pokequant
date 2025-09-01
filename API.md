## API Overview (Higher-Level Guide)

Canonical machine contract: `openapi.yaml` + `docs/API_CONTRACT.md`.

### Authentication
Header | Purpose
`x-admin-token` | Admin privileged endpoints
`x-ingest-token` | Ingestion posting (trends, etc.)
`x-portfolio-id` + `x-portfolio-secret` | Portfolio scoped endpoints

### Core Resources
Resource | Representative Endpoints
Cards | GET /api/cards, GET /api/card?id=, GET /api/movers
Search | GET /api/search?q=
Signals | (embedded in card responses; future: /api/signals)
Portfolio | GET/POST /api/portfolio, /api/portfolio/nav, /api/portfolio/pnl
Alerts | POST /api/alerts, GET /api/alerts
Factors | /api/factors/* (analytics & explainability)
Admin Ops | /admin/* (metrics, integrity, migrations, pipeline)

### Error Model
Errors return JSON: `{ ok:false, code, message }` with `code` enumerated in `src/lib/errors.ts`.

### Rate Limiting
Enforced per IP / token on search, subscribe, alert creation. Headers may later include limit usage.

### Versioning
Breaking response field removals require version bump (see `version.ts`) & contract update PR.
