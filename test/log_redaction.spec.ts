import { describe, it, expect } from 'vitest';
import { startLogCapture, stopLogCapture, log } from '../src/lib/log';

// Test that sensitive key names are redacted in structured logs

describe('Log redaction', () => {
  it('redacts secret-like fields', () => {
    startLogCapture();
    log('test_event', { apiKey: 'abc123', password: 'p@ss', token: 't', nested: { authHeader: 'Bearer 123' } });
    const logs = stopLogCapture();
    const entry = logs.find(l => l.event === 'test_event');
    expect(entry).toBeTruthy();
    if (entry) {
      expect(entry.apiKey).toBe('[REDACTED]');
      expect(entry.password).toBe('[REDACTED]');
      expect(entry.token).toBe('[REDACTED]');
      // nested object not deeply scanned currently; ensure original nested object retained (best-effort policy docs later)
      expect(entry.nested.authHeader).toBe('[REDACTED]');
    }
  });
});
