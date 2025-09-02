# Decision 0005: Email Provider Selection

Date: 2025-09-01
Status: Accepted

## Context
We require a transactional email provider for alert notifications (threshold alerts, escalation notices, system diagnostics). Requirements:
- Simple API (JSON over HTTPS)
- Reasonable free/low-volume tier for Beta
- Webhook support for bounces / complaints (future: delivered events)
- Domain authentication (SPF, DKIM) straightforward on Cloudflare DNS
- Low vendor lock-in (ability to abstract provider behind adapter)

Providers considered: Resend, Postmark.

## Options
1. Resend
   - Pros: Minimal API, good DX, straightforward key auth, rapid setup, modern JSON payloads, free tier suitable for Beta volume, supports inbound event webhooks.
   - Cons: Delivered event semantics still maturing; rate limits less explicitly documented.
2. Postmark
   - Pros: Mature deliverability tooling, detailed dashboards, robust bounce/complaint classifications.
   - Cons: More complex templating model, slightly heavier integration overhead for MVP, pricing may be less optimal for very low initial volumes.

## Decision
Choose **Resend** as the initial provider.

Rationale: Fast integration path aligns with Beta schedule, existing adapter already prototypes Resend behavior, webhook for bounce/complaint easily normalized. Abstraction layer (`sendEmail` in `email_adapter.ts`) keeps swap flexibility if deliverability or pricing concerns arise.

## Implementation Notes
- Feature flag `EMAIL_REAL_SEND=1` gates real sends to prevent accidental production blast before domain auth verification.
- Simulation mode enforced when `RESEND_API_KEY` is `test` or flag disabled; metrics emitted with `.sim` suffix.
- Real path increments `email.sent` + `email.sent.real` (delivered metric now sourced exclusively from `/webhooks/email/delivered`).
- Bounce / complaint ingestion endpoint `/webhooks/email/bounce` normalizes to `email.event.{bounce,complaint}` plus legacy metrics.
- Delivered events now ingested via `/webhooks/email/delivered` (resend). Removed optimistic increment in send path.

## Follow-Up Tasks
- [ ] Domain authentication (SPF, DKIM, optional DMARC) – document TXT records once provisioned.
- [x] Delivered event webhook path + schema.
- [ ] Remove optimistic delivered increment (real send path) once webhook live.
- [ ] Add provider error code taxonomy mapping to normalized internal error codes.
- [ ] Alert operations runbook section update (provider incident handling, retry strategy for transient 5xx from provider API).

## Revisit Criteria
Reassess provider choice if:
- Bounce / delivered event latency consistently > acceptable SLA threshold.
- Cost projections exceed target for Beta scaling.
- API stability issues (breaking changes or throttling) occur during ramp.

---
Linked Metrics: `email.sent`, `email.sent.real`, `email.send_error.*`, `email.event.bounce`, `email.event.complaint`, future `email.delivered` webhook.
