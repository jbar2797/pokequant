import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Portfolio secret rotation', () => {
  it('rotates secret and invalidates old one', async () => {
    const create = await SELF.fetch('https://example.com/portfolio/create', { method:'POST' });
    expect(create.status).toBe(200);
    const { id, secret } = await create.json() as any;
    // Rotate
    const rot = await SELF.fetch('https://example.com/portfolio/rotate-secret', { method:'POST', headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    expect(rot.status).toBe(200);
    const { secret: newSecret } = await rot.json() as any;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(secret);
    // Old secret should now fail
    const fail = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': secret } });
    expect(fail.status).toBe(403);
    // New secret works
    const ok = await SELF.fetch('https://example.com/portfolio', { headers:{ 'x-portfolio-id': id, 'x-portfolio-secret': newSecret } });
    expect(ok.status).toBe(200);
    const j = await ok.json() as any;
    expect(j.ok).toBe(true);
  });
});
