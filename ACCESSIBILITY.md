# Accessibility Overview

This document captures the current a11y posture of the PokeQuant web app and remaining gaps.

## Implemented
* Semantic landmarks: `<header>`, `<section>` with `aria-label`, `<table>` for tabular data.
* Keyboard operability: All interactive controls are native `<button>` / `<a>` or input elements.
* Focus styles: Default browser focus plus custom ring via Tailwind (TODO: global focus style refinement).
* Color tokens respect contrast-friendly palette (verify WCAG AA via tooling – pending automated check).
* Reduced motion: Chart swaps to tabular fallback when `prefers-reduced-motion` is set (consumer can pass `reducedMotion`).
* Toasts use Radix (polite live region) and now support action buttons.

## Newly Added (Batch 1)
* Skip link to main content.
* Global `role="main"` wrap for primary page content.
* ARIA live region for route change announcements (polite) to complement toast live region.
* Accessible timeframe & overlay controls on chart (buttons grouped with `aria-label`).

## Backlog / Planned
| Area | Gap | Planned Action |
|------|-----|----------------|
| Automated testing | No axe tests running | Introduce `vitest.a11y.config.ts` with isolated jsdom + jest-axe |
| Color contrast | Not yet audited | Add script to run `axe` against Storybook build CI |
| Focus order | Skip link only; no outline unification | Add global focus ring utility and visible skip link on focus |
| Chart accessibility | Data summary missing | Add textual summary (min/avg/max) below chart |
| Keyboard shortcuts | None | Provide `?` dialog & shortcuts (later) |
| Form validation | Errors shown inline but not linked | Add `aria-describedby` tying inputs to error IDs |

## Testing Strategy
1. Unit a11y snapshots with jest-axe for critical components (Button, DataTable, TimeseriesChart fallback, Forms).
2. Playwright a11y scans for core pages (search, card detail, portfolio) in CI.
3. Manual keyboard traversal checklist before release.

## Definition of Done (A11y)
* No critical / serious axe violations on core flows.
* All interactive elements reachable via Tab / Shift+Tab.
* Visible focus indicator always present.
* Color contrast AA for text < 24px & AAA for large headings optional stretch goal.
* Reduced motion honored (chart fallback, no uncontrolled animations).

---
Incrementally update this file as improvements land.