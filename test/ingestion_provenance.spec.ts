import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for ingestion provenance endpoint

describe('Ingestion provenance', () => {
  it('creates a synthetic backfill job and records provenance', async () => {
    const run = await SELF.fetch('https://example.com/admin/backfill', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', days:5 }) });
    expect(run.status).toBe(200);
    const list = await SELF.fetch('https://example.com/admin/ingestion/provenance', { headers:{'x-admin-token':'test-admin'} });
    expect(list.status).toBe(200);
    const j: any = await list.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.rows)).toBe(true);
  });
});
