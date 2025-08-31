import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Dual admin token support smoke test (single test to avoid multiple isolate spins)

describe('Admin dual token', () => {
  it('accepts primary and rejects random token', async () => {
    const ok = await SELF.fetch('https://example.com/admin/version', { headers:{'x-admin-token':'test-admin'} });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch('https://example.com/admin/version', { headers:{'x-admin-token':'invalid'} });
    expect(bad.status).toBe(403);
  });
});
