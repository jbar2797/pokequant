import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for mock external ingestion endpoint

describe('Mock external price ingestion', () => {
  it('ingests deterministic prices and records provenance', async () => {
    const res = await SELF.fetch('https://example.com/admin/ingest/prices', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ days:4 }) });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.inserted).toBeGreaterThan(0);
    const prov = await SELF.fetch('https://example.com/admin/ingestion/provenance', { headers:{'x-admin-token':'test-admin'} });
    const pj: any = await prov.json();
    expect(pj.ok).toBe(true);
    expect(pj.rows.some((r: any)=> r.source === 'external-mock')).toBe(true);
  });
});
