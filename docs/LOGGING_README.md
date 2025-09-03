# Logging & External Sink

This document summarizes the structured logging subsystem.

## Overview
- JSON line logs via `log(event, fields)`.
- In-memory ring buffer (last ~200 entries) exposed at `/admin/logs/recent`.
- External sink modes (env `LOG_SINK_MODE`):
  - `r2`: batches flushed to `LOGS_R2` bucket as NDJSON objects (`logs/<timestamp>_<uuid>.ndjson`).
  - `memory`: test mode; batches retained in-memory (not persisted) and exposed via stats.
  - `http`: POST batches to `LOG_SINK_ENDPOINT` with optional bearer auth `LOG_SINK_AUTH`.

## Flush Mechanics
- Buffer collects entries; when it reaches 50 entries a fire-and-forget flush triggers.
- Manual flush endpoint: `POST /admin/logs/flush` (admin token required) returns current stats.
- Retries: up to 3 attempts with exponential backoff + jitter (50ms base).
- Metrics (daily counters): `log.flush`, `log.flush_error`, `log.flush_retry`.
- Stats endpoint: `GET /admin/logs/stats` returns counts, pending buffer, last flush bytes.

## Redaction
Shallow redaction on key names containing: `secret`, `token`, `password`, `apikey`, `auth` (case-insensitive). Nested single-depth object keys also scanned.

## Adding a New Sink
Wrap implementation inside `flushExternal` in `src/lib/log.ts` using `mode` dispatch. Emit metrics via internal `logMetric` helper (avoid circular dependency on full metrics module).

## Idempotency & Reliability
Logging is best-effort; failure increments error metrics but never blocks request path. For critical audit events rely on persisted tables (`audit`).

## Future Enhancements
- Compression (gzip) for R2 / HTTP to reduce payload size.
- Dynamic flush interval timer (time-based) besides size trigger.
- Sampling controls per event class.
- Persistent circuit breaker state for sinks.

