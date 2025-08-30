import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Tests for /admin/ingestion/run incremental behavior

describe('Ingestion run incremental', () => {
  it('advances cursor and records provenance', async () => {
    // Upsert config with old cursor
    const up = await SELF.fetch('https://example.com/admin/ingestion/config', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'prices_daily', source:'ext-seq', cursor:'2025-01-01', enabled:true }) });
    expect(up.status).toBe(200);
    // Run ingestion (should advance)
    const run = await SELF.fetch('https://example.com/admin/ingestion/run', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ maxDays:2 }) });
    expect(run.status).toBe(200);
    const jr:any = await run.json();
    expect(jr.ok).toBe(true);
    const entry = jr.runs.find((r:any)=> r.source==='ext-seq');
    expect(entry).toBeTruthy();
    expect(entry.inserted).toBeGreaterThan(0);
    expect(entry.cursor).toBe(entry.to_date);
    // Run again immediately (likely skip if cursor now today)
    const run2 = await SELF.fetch('https://example.com/admin/ingestion/run', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ maxDays:2 }) });
    expect(run2.status).toBe(200);
    const jr2:any = await run2.json();
    expect(jr2.ok).toBe(true);
  });
});
