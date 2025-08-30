import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Dual admin token support smoke test

describe('Admin dual token', () => {
  it('accepts primary admin token', async () => {
    const r = await SELF.fetch('https://example.com/admin/version', { headers:{'x-admin-token':'test-admin'} });
    expect(r.status).toBe(200);
  });
  it('rejects random token when NEXT not set', async () => {
    const r = await SELF.fetch('https://example.com/admin/version', { headers:{'x-admin-token':'invalid'} });
    expect(r.status).toBe(403);
  });
});
