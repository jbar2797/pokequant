import { describe, it, expect } from 'vitest';
import { computeFactorReturns } from '../src/lib/factors';

// DB stub to force skipped=true branches by missing required latest/prev metadata rows.
function makeDB() {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async all() {
          // meta query returns empty -> triggers skipped path
          if (/WITH latest AS \(SELECT MAX\(as_of\)/i.test(sql)) {
            return { results: [] } as any;
          }
          return { results: [] } as any;
        },
        async run() { return { success: true } as any; },
      };
    },
  } as any;
}

describe('factor returns skip lightweight unit', () => {
  it('skips when metadata days missing', async () => {
    const env: any = { DB: makeDB() };
    const res = await computeFactorReturns(env);
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe(true);
  });
});
