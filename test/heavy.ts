import { it } from 'vitest';

// Helper to conditionally skip heavy tests when FAST_TESTS mode is enabled.
// Usage: heavy('description', async () => { ... }, timeout?)
export function heavy(name: string, fn: () => any | Promise<any>, timeout?: number) {
  const fast = (globalThis as any).__FAST_TESTS === '1' || (globalThis as any).FAST_TESTS === '1';
  if (timeout !== undefined) {
    (fast ? it.skip : it)(name, fn, timeout);
  } else {
    (fast ? it.skip : it)(name, fn);
  }
}
