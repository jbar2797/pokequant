import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Retention purge', () => {
  it('runs retention and returns deleted counts object', async () => {
    const res = await SELF.fetch('https://example.com/admin/retention', { method:'POST', headers:{ 'x-admin-token':'test-admin' } });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.deleted && typeof j.deleted === 'object').toBe(true);
  });
});
