import { describe, it, expect } from 'vitest';
import { runBacktest } from '../src/lib/backtest';

// Minimal DB stub returning no signal rows to exercise early no_data branch.
function makeDB() {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async all() {
          if (/FROM signals_daily/i.test(sql)) {
            return { results: [] } as any; // triggers no_data path
          }
          return { results: [] } as any;
        },
        async run() { return { success: true } as any; },
      };
    },
  } as any;
}

describe('backtest no_data lightweight unit', () => {
  it('returns no_data when there are no signals', async () => {
    const env: any = { DB: makeDB() };
    const res = await runBacktest(env, { lookbackDays: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_data');
  });
});
