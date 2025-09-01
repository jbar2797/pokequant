# Decision: Email Provider Selection (Resend vs Postmark)

Date: 2025-08-31
Status: Proposed
Owners: Engineering

## Context
System currently uses a stub email adapter for alert notifications. Need production provider for deliverability, analytics, and webhook feedback (bounces, complaints) before broad rollout.

## Options
### A. Resend
Pros:
- Simple API, modern DX
- Native Typescript SDK
- Competitive pricing at low volume
- Supports batch, scheduling, inbound routes
Cons:
- Newer provider; long-term deliverability track record still maturing
- Fewer built-in deliverability analytics than legacy incumbents

### B. Postmark
Pros:
- Strong deliverability reputation (transactional focus)
- Rich bounce/complaint categorization
- Message Streams separation (broadcast vs transactional)
Cons:
- Pricing slightly higher at low volume tiers
- API less minimal; TS SDK community-driven

### C. SES (Amazon Simple Email Service)
Pros:
- Low cost at scale
- High availability
Cons:
- More operational overhead (DKIM/SPF, reputation mgmt)
- Quotas / sandbox friction

## Evaluation Criteria
| Criterion | Weight | Resend | Postmark | SES |
|----------|--------|--------|----------|-----|
| Deliverability Track Record | 30% | Medium | High | High |
| API Simplicity / DX | 25% | High | Medium | Low |
| Integration Effort | 15% | Low | Low | High |
| Webhook Richness | 10% | Medium | High | Medium |
| Cost (MVP volume <50k/mo) | 10% | Medium | Medium | High |
| Future Scale (>500k/mo) | 10% | Medium | Medium | High |

## Decision
Adopt **Postmark** for initial production due to stronger deliverability analytics & bounce categorization, despite slightly higher cost. Re-evaluate at >250k monthly sends; consider dual integration with Resend if feature velocity becomes compelling or SES if cost pressure dominates at scale.

## Implementation Notes
- Add environment vars: `EMAIL_PROVIDER=postmark`, `POSTMARK_TOKEN` (secret).
- Update `email_adapter.ts` to branch on provider; keep stub path for tests.
- Implement webhook ingestion endpoint `/admin/email/webhook` capturing bounce, complaint, delivery events.
- Extend `email_deliveries` table with `event_type`, `event_ts`, `metadata` JSON.
- Add retry policy for transient provider errors (429, 5xx) with capped exponential backoff.

## Follow-Up Tasks
- Provision Postmark server & domain (SPF, DKIM, DMARC alignment).
- Capture provider message ID (already stored) and surface in admin UI.
- Alerting: raise incident if bounce rate > 3% over trailing 100 sends.
- Add DECISION review in 3 months (2025-11-30) to validate provider choice.

## Alternatives Rejected
- Rolling our own SMTP + queue: higher maintenance, weaker deliverability, no analytics.

---
(Generated as part of hardening batch to document external service selection.)
