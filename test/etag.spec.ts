import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

// Simple ETag validation test for universe endpoint using built-in test worker env.
describe('ETag', () => {
  it('returns 304 when If-None-Match matches', async () => {
    const r1 = await SELF.fetch('https://example.com/api/universe');
    expect(r1.status).toBe(200);
    const etag = r1.headers.get('ETag');
    expect(etag).toBeTruthy();
    const r2 = await SELF.fetch('https://example.com/api/universe', { headers: { 'If-None-Match': etag! } });
    expect(r2.status).toBe(304);
    expect(r2.headers.get('ETag')).toBe(etag);
  });
});