// Propagate FAST_TESTS env into globalThis so specs can reliably detect mode.
// Vitest runs in a Node-like harness before spinning up worker pool; we set a flag early.
try {
  const v = (globalThis as any).FAST_TESTS || (globalThis as any).__FAST_TESTS || (import.meta as any)?.env?.FAST_TESTS;
  if (v === '1') {
    (globalThis as any).__FAST_TESTS = '1';
  }
} catch { /* ignore */ }
