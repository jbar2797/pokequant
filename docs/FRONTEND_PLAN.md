# Frontend Overhaul Plan

Goal: Replace placeholder static site with a responsive, accessible, performant UI enabling alpha users to explore signals, cards, and manage a simple portfolio.

## Tech Evaluation
Options:
1. SvelteKit (static adapters) – small bundle, simple stores.
2. Next.js (App Router) – ecosystem & ISR; may be heavier.
3. Astro + Islands (hybrid) – static HTML first, hydrate components.

Recommendation (alpha): SvelteKit + Tailwind CSS (utility speed) + lightweight component primitives.

## Core Screens
1. Home / Dashboard
   - Movers Grid (top N movers with % change / signal score)
   - Summary metrics (universe size, updates freshness, latency badge)
2. Cards Explorer
   - Paginated table (columns: image, name, set, rarity, latest price, signal, score, sparkline)
   - Faceted filters (set, rarity, type, search query)
3. Card Detail Modal/Page
   - Price & signal sparkline (30/90d toggle)
   - Factors breakdown (components contributions)
   - Download CSV
4. Portfolio
   - Lots table (qty, cost, market value, unrealized PnL)
   - Exposures & attribution mini-charts
   - Secret rotation UI + instructions
5. Alerts
   - Create alert form (card chooser, threshold)
   - Active alerts list (status, last fired, deactivate)
6. Account / Settings (later)
   - API tokens (post-GA), webhooks config.

## Component Design Requirements
- Dark mode first (cards artwork pops) with semantic tokens.
- Skeleton loaders for movers & cards table.
- All interactive elements keyboard accessible, focus-visible.
- Reusable Chart component (small line sparkline, area baseline, tooltip).

## Data Fetch Strategy
- REST fetch with ETag conditional requests; client caches payload & revalidates.
- Global fetch wrapper handles rate-limit (429) with retry-after UI toast.

## Performance Targets
- First meaningful paint < 1.5s on mid-tier mobile (fast 3G profile) for initial HTML.
- Interaction readiness < 3s.
- Bundle size (JS) < 200KB gzipped initial route.

## Analytics (Optional Alpha)
- Simple event queue (page_view, card_view, portfolio_add_lot) posted batched to `/admin/analytics` (future) – feature flagged.

## Milestones
- Week 1: Choose stack, scaffold routing, theme tokens, data client.
- Week 2: Movers + Cards Explorer + Card Detail.
- Week 3: Portfolio + Alerts + polish, accessibility pass.
- Week 4: Refinement, performance budget, dark/light toggle.

## Acceptance Criteria (Alpha Frontend Done)
- All listed screens implemented.
- No major a11y violations (axe scan zero serious/critical).
- Lighthouse perf ≥ 85 (desktop), ≥ 75 (mobile) baseline.
- Error & loading states for every data panel.

