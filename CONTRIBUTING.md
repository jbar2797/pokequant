## Contributing Guide

Short & strict for internal alpha.

### Workflow
1. Branch from `main` using `feat/`, `fix/`, `chore/`, or `docs/` prefix.
2. Run: `npm run lint && npm run typecheck && npm test` before pushing.
3. Keep PRs <400 LOC (excluding snapshots/docs). Split otherwise.
4. Include checklist referencing relevant Alpha Gate items.

### Commit Messages
Conventional style (subset):
`feat: add portfolio exposure snapshot endpoint`
`fix: correct drawdown calculation for signals`
`chore: bump coverage ratchet`

### Testing Expectations
- Add / update unit tests for all logic changes.
- If modifying routes, add integration spec (test/). Use FAST_TESTS guards when heavy.
- Keep added test runtime <1s in fast mode.

### Docs
Update `docs/ENGINEERING_SNAPSHOT.md` summarizing notable architectural or data model changes.

### Coverage
Do not reduce coverage thresholds; if legitimately impossible, open a discussion issue.

### Security
Never commit secrets. Use `.env.example` additions for new vars.
