import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Basic smoke tests for new search metadata endpoints

describe('Search & metadata endpoints', () => {
  it('lists sets', async () => {
    const r = await SELF.fetch('https://example.com/api/sets');
    expect(r.status).toBe(200);
  });
  it('lists rarities', async () => {
    const r = await SELF.fetch('https://example.com/api/rarities');
    expect(r.status).toBe(200);
  });
  it('search works (empty ok)', async () => {
    const r = await SELF.fetch('https://example.com/api/search?q=char');
    expect(r.status).toBe(200);
  });
});
