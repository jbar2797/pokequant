import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { startLogCapture, stopLogCapture } from '../src/lib/log';

// Verifies that a cold start does not emit excessive metric_latency_error logs now that ensure + retry is in place.

describe('Log capture (latency ensure noise suppression)', () => {
  it('makes initial requests without metric_latency_error logs', async () => {
    startLogCapture();
    const r1 = await SELF.fetch('https://example.com/api/cards');
    expect(r1.status).toBe(200);
    const r2 = await SELF.fetch('https://example.com/api/search');
    expect(r2.status).toBe(200);
    // flush any pending microtasks
    await Promise.resolve();
    const logs = stopLogCapture();
    const latencyErrors = logs.filter(l => l.event === 'metric_latency_error');
    if (latencyErrors.length) {
      // Helpful debug output
      console.error('Unexpected metric_latency_error logs', latencyErrors);
    }
    expect(latencyErrors.length).toBe(0);
  });
});
