import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const ADMIN='test-admin';

describe('Ingestion schedule auto run', () => {
  it('runs due schedule and optionally ingests datasets', async () => {
    // Ensure a config for prices_daily exists
    await SELF.fetch('https://example.com/admin/ingestion-config', { method:'POST', headers:{ 'x-admin-token': ADMIN }, body: JSON.stringify({ dataset:'prices_daily', source:'scraperA', enabled:1 }) });
    // Add schedule entry directly
    await SELF.fetch('https://example.com/admin/ingestion-schedule', { method:'POST', headers:{ 'x-admin-token': ADMIN }, body: JSON.stringify({ dataset:'prices_daily', frequency_minutes: 0 }) });
    // Trigger run-due with run flag
    const run = await SELF.fetch('https://example.com/admin/ingestion-schedule/run-due?run=1', { method:'POST', headers:{ 'x-admin-token': ADMIN } });
    const rj: any = await run.json();
    expect(rj.ok).toBe(true);
    expect(Array.isArray(rj.ran)).toBe(true);
    // if ingested present, ensure structure
    if (rj.ingested) {
      expect(Array.isArray(rj.ingested)).toBe(true);
    }
  });
});
