import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Health endpoint', () => {
  it('returns ok on pristine DB with zero counts', async () => {
    const resp = await SELF.fetch('https://example.com/health');
    expect(resp.status).toBe(200);
  const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.counts).toBeDefined();
    // counts should have numeric fields even if zero
    expect(typeof body.counts.cards).toBe('number');
    expect(typeof body.counts.prices_daily).toBe('number');
    expect(typeof body.counts.signals_daily).toBe('number');
    expect(typeof body.counts.svi_daily).toBe('number');
  });
});
