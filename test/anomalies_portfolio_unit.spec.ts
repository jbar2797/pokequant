import { describe, it, expect } from 'vitest';
import { detectAnomalies } from '../src/lib/anomalies';
import { snapshotPortfolioFactorExposure } from '../src/lib/portfolio_exposure';

// Lightweight in-memory D1 stub sufficient for exercised code paths.
function makeDB() {
  return {
    _tables: new Map<string, any[]>(),
    prepare(sql: string) {
      const self = this;
      return {
        bind() { return this; },
        async run() {
          // Simulate table creation & inserts as no-ops.
          // Track anomalies & portfolio_factor_exposure inserts for assertions.
          if (/INSERT OR REPLACE INTO anomalies/i.test(sql)) {
            const m = sql.match(/anomalies/); if (m) { /* count via side effect */ (self as any)._anomalyInserts = ((self as any)._anomalyInserts||0)+1; }
          }
          if (/INSERT OR REPLACE INTO portfolio_factor_exposure/i.test(sql)) {
            (self as any)._pexpInserts = ((self as any)._pexpInserts||0)+1;
          }
          return { success: true } as any;
        },
        async all() {
          // Anomalies detector queries a WITH latest ... SELECT over cards.
          if (/FROM cards c/i.test(sql)) {
            // Return two cards with big price move to trigger anomaly insert branch once.
            return { results: [
              { card_id: 'c1', px_l: 200, px_p: 100 }, // +100% (spike)
              { card_id: 'c2', px_l: 50, px_p: 60 },   // -16% (below threshold ignored)
            ] } as any;
          }
          // Portfolio exposure selects distinct portfolio ids.
            if (/SELECT DISTINCT portfolio_id FROM portfolio_nav/i.test(sql)) {
              return { results: [ { portfolio_id: 'p1' } ] } as any;
            }
          // Components join for exposure aggregation.
          if (/FROM signal_components_daily sc JOIN portfolio_nav nav/i.test(sql)) {
            return { results: [
              { ts7: 1, ts30: 2, z_svi: 0.5, vol: 3, liquidity: 4, scarcity: 5, mom90: 6 },
              { ts7: 2, ts30: 3, z_svi: 0.6, vol: 4, liquidity: 5, scarcity: 6, mom90: 7 },
            ] } as any;
          }
          return { results: [] } as any;
        },
      };
    },
  } as any;
}

describe('anomalies + portfolio exposure lightweight unit', () => {
  it('detects at least one anomaly and snapshots portfolio exposure', async () => {
    const DB = makeDB();
    const env: any = { DB, FAST_TESTS: '0' }; // override fast tests skip
    await detectAnomalies(env);
    await snapshotPortfolioFactorExposure(env);
    expect(DB._anomalyInserts || 0).toBeGreaterThan(0); // anomaly inserted
    expect(DB._pexpInserts || 0).toBeGreaterThan(0); // exposure rows inserted
  });
});
