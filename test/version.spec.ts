import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Admin version', () => {
  it('returns version', async () => {
    const r = await SELF.fetch('https://example.com/admin/version', { headers: { 'x-admin-token':'test-admin' }});
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(typeof j.version).toBe('string');
    expect(j.version).toMatch(/^\d+\.\d+\./);
  });
});