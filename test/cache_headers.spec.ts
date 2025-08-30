import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Cache headers', () => {
  it('sets Cache-Control on universe', async () => {
    const r = await SELF.fetch('https://example.com/api/universe');
    expect(r.status).toBe(200);
    const cc = r.headers.get('cache-control') || '';
    expect(cc).toContain('max-age=');
  });
});
