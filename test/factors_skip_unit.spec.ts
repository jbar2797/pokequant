import { describe, it, expect } from 'vitest';
import { computeFactorIC } from '../src/lib/factors';

// DB stub to trigger skipped path (meta query returns row lacking prev/latest days)
function makeDB() {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async all() {
          if (/WITH latest AS \(SELECT MAX\(as_of\)/i.test(sql)) {
            return { results: [{ prev_d: null, latest_d: null }] } as any; // triggers skipped true
          }
          return { results: [] } as any;
        },
        async run() { return { success: true }; },
      };
    },
  } as any;
}

describe('factor IC skip branch', () => {
  it('skips when meta lacks dates', async () => {
    const env: any = { DB: makeDB() };
    const res = await computeFactorIC(env);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
  });
});
