# Decision: Email Provider Selection

Date: 2025-09-01
Status: Pending (Draft)
Owners: Engineering

## Context
We require a production email provider for alert notifications with:
- Reliable delivery + bounce/complaint webhooks
- Simple API (JSON) + TypeScript friendly
- Reasonable early-stage pricing (low volume)
- DKIM/SPF setup simplicity
- Clear error codes for transient vs permanent failures

Currently adapter (`email_adapter.ts`) supports Resend (feature-flag) and a placeholder for Postmark via `EMAIL_PROVIDER` env var.

## Options
1. Resend
2. Postmark
3. SendGrid (rejected early: heavier, noisier API, complex templates)

## Evaluation
| Criteria | Weight | Resend | Postmark |
|----------|--------|--------|----------|
| API Simplicity | High | Simple POST /emails | Clean, more legacy concepts |
| Bounce/Complaint Webhooks | High | Yes | Yes |
| Pricing (low volume) | Medium | Competitive | Competitive |
| Error Clarity | Medium | Modern JSON error shape | Well documented codes |
| Implementation Effort | Medium | Already partially implemented | Would need new branch |

## Tentative Lean
Resend (adapter in place, minimal incremental work). Will finalize after verifying DKIM setup duration and bounce payload shape suffices for status enrichment.

## Decision
TBD (target before 2025-09-04). Update status to Accepted and record rationale + any follow-up tasks.

## Follow-up Tasks
- Implement bounce/complaint event normalization table (`email_events`).
- Extend `email_deliveries` with status columns (delivered_at, bounced_at, complaint_at).
- Add metrics `email.delivered`, `email.bounced`, `email.complaint` (bounced/complaint partially present as placeholders).
- Update Operations Runbook with bounce remediation steps.
- Add test vectors using provider test key.

## Reversal Strategy
Adapter is pluggable by env `EMAIL_PROVIDER`; if deliverability issues arise we can pivot to Postmark by adding Postmark implementation and redeploying with new env vars; schema remains provider-agnostic.

