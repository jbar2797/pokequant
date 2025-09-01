import { describe, it, expect, vi } from 'vitest';
import { runRoute, finalizeRequest } from '../src/lib/http_runtime';

// Minimal DB stub used by metrics helpers invoked inside http_runtime utilities.
function makeDB() {
  return {
    _rows: new Map<string, any>(),
    prepare(sql: string) {
      const self = this;
      return {
        _sql: sql,
        bind() { return this; },
        async run() { return {}; },
        async all() {
          // metrics selects count from metrics_daily — return empty so code takes initialization branches
          if (/SELECT count FROM metrics_daily/i.test(sql)) return { results: [] } as any;
          return { results: [] } as any;
        },
      };
    },
  } as any;
}

describe('http_runtime helpers', () => {
  it('runRoute captures success and error paths; finalizeRequest buckets', async () => {
    const env: any = { DB: makeDB() };
    // Success path
    const r1 = await runRoute('ok', { req: new Request('http://x/'), env }, async () => new Response('ok', { status: 200 }));
    expect(r1.response.status).toBe(200);
    // Error path (handler throws)
    const r2 = await runRoute('boom', { req: new Request('http://x/'), env }, async () => { throw new Error('fail'); });
    expect(r2.response.status).toBe(500);

    // Exercise multiple latency buckets by controlling Date.now sequence
    const base = Date.now();
    const seq = [base, base+10, base+60, base+200, base+400, base+800, base+1500];
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => seq[0] ?? base);
    const url = new URL('http://x/test');
    const statuses = [200, 404, 500, 201, 429]; // exclude 204/205/304 to avoid body constraint
    for (const s of statuses) {
      const t0 = Date.now(); // consumes one timestamp
      seq.shift();
      const bodyOk = s === 204 || s === 205 || s === 304 ? null : 'x';
      const resp = await finalizeRequest(env, url, 'test_tag', t0, new Response(bodyOk, { status: s }));
      expect(resp.status).toBe(s);
    }
    spy.mockRestore();
  });
});
