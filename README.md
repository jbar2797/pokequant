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

Rate limit overrides (optional):
- RL_SEARCH_LIMIT / RL_SEARCH_WINDOW_SEC (default 30 per 300s)
- RL_SUBSCRIBE_LIMIT / RL_SUBSCRIBE_WINDOW_SEC (default 5 per 86400s)
- RL_ALERT_CREATE_LIMIT / RL_ALERT_CREATE_WINDOW_SEC (default 10 per 86400s)

Provide as Wrangler vars to tune without code changes.

## API
See `openapi.yaml` and `docs/API_CONTRACT.md`.

## CI
GitHub Actions workflow runs:
- install deps (node cache by lock hash)
- contract check (`npm run contract`)
- version sync check (`npm run version-check`)
- lint, typecheck, tests
Fail-fast on contract or version drift to keep spec, code, and version aligned.

## Roadmap (next increments)
- Rate limiting (KV token bucket) for search & alerts
- Expanded signal model (robust stats, factor attribution)
- Extended test coverage (portfolio P&L calc, alert firing happy + edge cases)
- Structured error schema + OpenAPI components
- Metrics export (durations, counts) via logs

## License
Proprietary (set desired license).
