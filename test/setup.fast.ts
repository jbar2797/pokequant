// Propagate FAST_TESTS env into globalThis so specs can reliably detect mode.
// Vitest runs in a Node-like harness before spinning up worker pool; we set a flag early.
try {
  const v = (globalThis as any).FAST_TESTS || (globalThis as any).__FAST_TESTS || (import.meta as any)?.env?.FAST_TESTS;
  if (v === '1') {
    (globalThis as any).__FAST_TESTS = '1';
  }
} catch { /* ignore */ }
// Global FAST_TESTS propagation already occurs in scripts/test-bootstrap.js
// Here we augment SELF.fetch with a retry wrapper to reduce transient 'Network connection lost' flakes.
// We keep idempotency assumptions: tests mostly perform simple reads or short-lived POSTs that are safe to retry.
import { beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';

beforeAll(() => {
  try {
    const anySelf = SELF as any;
    if (anySelf && !anySelf.__fetchPatched) {
      const orig = anySelf.fetch.bind(anySelf);
      anySelf.fetch = async (input: any, init?: any) => {
        const max = (init && init.__retry != null) ? init.__retry : 2;
        if (init) delete init.__retry;
        let attempt = 0;
        while (true) {
          try { return await orig(input, init); }
          catch (e: any) {
            const msg = String(e||'');
            if (!/Network connection lost/i.test(msg) || attempt >= max) throw e;
            await new Promise(r=> setTimeout(r, 60 * (attempt+1)));
            attempt++;
          }
        }
      };
      anySelf.__fetchPatched = true;
    }
  } catch {/* ignore */}
});
