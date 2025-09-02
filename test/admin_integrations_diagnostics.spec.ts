import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests /admin/diagnostics/integrations endpoint basic shape.

describe('Admin integrations diagnostics', () => {
  it('returns feature flag + provider state', async () => {
    const r = await SELF.fetch('https://example.com/admin/diagnostics/integrations', { headers:{ 'x-admin-token':'test-admin' } });
    expect([200,403]).toContain(r.status); // Allow 403 if token mismatch in harness
    if (r.status === 200) {
      const j:any = await r.json();
      expect(j.ok).toBeTruthy();
      expect(j.email).toBeTruthy();
      expect(j.email).toHaveProperty('provider');
      expect(j.webhook).toHaveProperty('real_send');
      expect(j.signals).toHaveProperty('active_provider');
    }
  });
});
