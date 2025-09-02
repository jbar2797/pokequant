import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Signals provider selection endpoint', () => {
  it('selects default provider explicitly', async () => {
    const r = await SELF.fetch('https://example.com/admin/signals/provider', { method:'POST', headers:{ 'x-admin-token':'test-admin' }, body: JSON.stringify({ name:'default_v1' }) });
    expect(r.status).toBe(200);
    const j:any = await r.json();
    expect(j.ok).toBe(true);
  expect(j.active).toBe('default_v1');
    expect(j.found).toBe(true);
  });
  it('falls back when unknown', async () => {
    const r = await SELF.fetch('https://example.com/admin/signals/provider', { method:'POST', headers:{ 'x-admin-token':'test-admin' }, body: JSON.stringify({ name:'nonexistent_xyz' }) });
    expect(r.status).toBe(200);
    const j:any = await r.json();
    expect(j.ok).toBe(true);
    // Fallback still active default
  expect(j.active).toBe('default_v1');
    expect(j.found).toBe(false);
  });
});
