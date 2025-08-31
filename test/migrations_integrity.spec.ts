import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Regression: ensure migrations rerun (integrity probe) when D1 storage is rotated across specs.
// We simulate by performing a normal request (ensures tables), then directly dropping a core table
// via /admin/test-reset (if added) or by relying on isolated storage creating fresh DB per spec.
// This spec simply asserts core endpoints work (cards table present) despite preceding specs having run.

describe('Migrations integrity', () => {
  it('ensures core tables exist in a fresh spec (rarities endpoint works)', async () => {
    // This hits a metadata route that depends on the cards table existing.
    // If migrations failed to rerun for a fresh DB instance we would see a 500 (no such table: cards).
    const res = await SELF.fetch('https://example.com/api/rarities');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Should contain objects with v/n keys (can be empty if seed absent but seed ensures at least one)
    if (body.length) {
      expect(body[0]).toHaveProperty('v');
    }
  });
});
