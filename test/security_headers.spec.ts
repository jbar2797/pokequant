import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Security headers', () => {
  it('root responds with baseline security headers', async () => {
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});