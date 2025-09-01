## PR Title (Conventional)

### Summary
Explain the change briefly.

### Checklist
- [ ] Tests added/updated
- [ ] Lint & typecheck pass locally
- [ ] Docs updated (ENGINEERING_SNAPSHOT / READMEs / API / Data Dictionary as needed)
- [ ] Coverage ratchet unaffected or increased
- [ ] No secrets committed

### Risk
Describe risk & rollback plan.

### Screenshots / Logs (if UI or perf)
## Summary
<!-- What changed and why? -->

## Checklist
- [ ] Updated **docs/API_CONTRACT.md** when changing/adding public endpoints or response shapes
- [ ] Ran local smoke: `BASE=<worker-url> scripts/smoke.sh` (attach output)
- [ ] Considered rate limits and data freshness (no long loops inside requests)
- [ ] Added/updated ADR if architecture decisions changed

## Screenshots / Logs
<!-- Optional -->
