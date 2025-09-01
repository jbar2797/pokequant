# Decision: Webhook Signing Specification

Date: 2025-09-01
Status: Draft

## Goals
- Provide tamper detection & replay protection for outbound webhooks.
- Simple for consumers to implement (HMAC SHA-256).
- Deterministic canonical string; avoid JSON re-stringification inconsistencies.

## Proposed Canonical String
```
<timestamp>.<nonce>.<sha256_hex_of_raw_body>
```
Where:
- `timestamp` = UNIX seconds (integer) when signature generated.
- `nonce` = cryptographically random UUID v4 without dashes (or base64url 16 bytes) unique per delivery attempt.
- `sha256_hex_of_raw_body` = lowercase hex digest of the exact UTF-8 bytes sent.

## Headers Sent
- Primary spec headers (lowercase transmitted internally but shown canonicalized here):
	- `X-Webhook-Timestamp`: timestamp
	- `X-Webhook-Nonce`: nonce
	- `X-Webhook-Signature`: hex(HMAC_SHA256(secret, canonical_string))
- Temporary Legacy Compatibility (to be removed after clients migrate):
	- `x-signature`, `x-signature-ts`, `x-signature-nonce` (older draft naming) emitted in parallel.
- (Optional future) `X-Webhook-Attempt`: attempt number (1..N retries)

## Consumer Verification Steps
1. Recompute body SHA-256 hex.
2. Construct canonical string as above.
3. HMAC with shared secret (hex lower-case) using SHA-256.
4. Constant-time compare vs `X-Webhook-Signature` (or temporary legacy `x-signature`).
5. Ensure timestamp within acceptable clock skew window (e.g. ±5m).
6. Ensure nonce not seen before (consumer must store nonce for replay protection window, e.g. 24h).

## Replay Protection (Provider Side)
We already store nonce in `webhook_deliveries` for each attempt, enabling redelivery detection.

## Rationale
- Including body hash allows large payload streaming verification without buffering canonical JSON order.
- Separating the body digest from timestamp/nonce prevents canonicalization issues due to whitespace.

## Alternatives Considered
- Raw body concatenation instead of hash (risk: line ending variations; large payload overhead).
- JSON canonicalization (risk: complexity & language differences).

## Open Questions
- Should we include endpoint ID in canonical string? (Not necessary; secret isolates per endpoint.)
- Rotating secrets: new deliveries sign with new secret immediately after rotation; old secret invalid thereafter.

## Next Steps
- Implement feature flag `WEBHOOK_REAL=1` for real network dispatch.
- Add signing implementation & tests producing known vector.
- Document verification sample in `API_CONTRACT.md` once live.

