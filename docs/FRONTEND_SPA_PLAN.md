# Frontend SPA Plan (Phase 1)

Status: Draft (Initial static shell present in `public/`)

## Objectives
Transition from static multi-script dashboard to a modular SPA shell with:
- Client-side router (hash-based) for Overview, Cards, Card Detail (modal/deeplink), Portfolio.
- Lightweight state store (no framework) initially; pluggable for future SvelteKit migration.
- ETag-aware fetch wrapper with stale-while-revalidate behavior.
- Accessible navigation (ARIA landmarks, focus management, skip links).
- Performance budget: critical render < 150ms scripting on mid-tier laptop, bundle < 50KB gzip initial.

## Phase Breakdown
### Phase 1 (Current)
- Static HTML + progressive enhancement scripts (`core.js`, `movers.js`, `portfolio.js`, `app-new.js`).
- Card modal partial detail fetch.

### Phase 2 (This Sprint)
- Introduce `router.js` with hash routes: `#/overview`, `#/cards`, `#/card/<id>`, `#/portfolio`.
- Refactor navigation buttons to anchor tags with `href` to enable deep linking + back button.
- Expose `navigate()` API updating state + analytics (future).

### Phase 3
- Central store module (`store.js`) consolidating cards, portfolio, movers caches with timestamp + ETag tracking.
- Implement stale-if-age<30s fast path else fire background refresh.

### Phase 4
- Split feature modules loaded dynamically via `import()` on first navigation (code-splitting placeholder until full bundler integration).
- Add route-level error boundaries + loading skeleton components.

### Phase 5
- Accessibility audit: focus trap for modal, aria-live region for data refresh announcements, keyboard nav improvements.
- Basic metric instrumentation (custom event queue) bridging to backend ingestion endpoint (future).

## Data Fetch Strategy
`fetchJSONWithCache(url)`:
1. Check in-memory cache entry (contains: data, etag, ts).
2. If age < TTL (route-specific) return immediately.
3. Issue conditional request `If-None-Match` when ETag known.
4. On 304 update ts only; on 200 replace data+etag.

## Initial TTLs
- Movers: 60s
- Cards list: 300s (slice to 200 visible rows)
- Portfolio lots: 60s

## Metrics (Future)
- window.PQ.metrics.increment(name) no-op shim now; later dispatch batched to `/admin/metrics/ingest` (planned).

## Migration to SvelteKit (Deferred)
Evaluate once domain model stabilizes; until then keep framework-less to minimize churn.

---
Short Term TODO:
- [ ] Implement router.js + hash links.
- [ ] Replace button nav with anchor tags.
- [ ] Add deep link open for card modal using `#/card/<id>`.
- [ ] Introduce cache fetch utility and migrate movers/cards loads.

Owner: Frontend Engineering
Review Date: 2025-09-07