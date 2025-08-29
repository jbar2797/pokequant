# PokeQuant (MVP)

Edge analytics & signals for premium Pokémon TCG cards. Cloudflare Worker + D1.

## Quick Start

```bash
npm install
make dev      # run worker locally
make test     # vitest
make typecheck
make lint
make smoke    # hits local endpoints
```

Deploy:
```bash
make deploy
```

Environment variables: copy `.env.example` and set via Wrangler or Cloudflare dashboard.

## API
See `openapi.yaml` and `docs/API_CONTRACT.md`.

## CI
GitHub Actions runs lint, typecheck, tests, and validates OpenAPI file presence.

## Roadmap (next increments)
- Rate limiting (KV token bucket) for search & alerts
- Expanded signal model (robust stats, factor attribution)
- Extended test coverage (portfolio P&L calc, alert firing happy + edge cases)
- Structured error schema + OpenAPI components
- Metrics export (durations, counts) via logs

## License
Proprietary (set desired license).
