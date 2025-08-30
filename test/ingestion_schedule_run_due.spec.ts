import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Ingestion schedule run-due', () => {
  it('runs due datasets and updates last_run_at', async () => {
    await SELF.fetch('https://example.com/admin/ingestion-schedule', { method:'POST', headers:{'x-admin-token':'test-admin','content-type':'application/json'}, body: JSON.stringify({ dataset:'signals_daily', frequency_minutes: 0 }) });
    const run = await SELF.fetch('https://example.com/admin/ingestion-schedule/run-due', { method:'POST', headers:{'x-admin-token':'test-admin'} });
    const rj:any = await run.json();
    expect(rj.ok).toBe(true);
    expect(Array.isArray(rj.ran)).toBe(true);
  });
});
