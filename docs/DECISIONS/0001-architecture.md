# ADR-0001: Cloudflare Worker + D1 + GH Actions (SVI)

- We run serverless (low cost), keep code lean, and precompute signals daily.
- D1 is the single source of truth for cards, prices, SVI, signals, and portfolio lots.
- Google Trends SVI is fetched via GH Actions (Python, pytrends) — avoids rate-limiting within Worker.
- Signals are computed daily and on-demand (`/admin/run-now`), with SVI-only fallback to ensure coverage.

Implications:
- Public API is read-mostly; mutations are minimal (subscribe, portfolio, ingest).
- We prioritize simple SQL and short requests; anything heavy is done in the pipeline.
