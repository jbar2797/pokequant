import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Simple smoke to ensure run-fast works repeatedly (provider abstraction stays stable)
describe('Signals provider swap (mock)', () => {
  it('runs run-fast twice without error (idempotent provider use)', async () => {
    for (let i=0;i<2;i++) {
      const r = await SELF.fetch('https://example.com/admin/run-fast', { method:'POST', headers: { 'x-admin-token':'test-admin' } });
      expect(r.status).toBe(200);
      const j:any = await r.json();
      expect(j.ok).toBe(true);
      expect(typeof j.idsProcessed).toBe('number');
    }
  });
});
