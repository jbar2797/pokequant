// Propagate FAST_TESTS env into globalThis for vitest specs skipping heavy tests.
if (process.env.FAST_TESTS === '1') {
  globalThis.FAST_TESTS = '1';
  globalThis.__FAST_TESTS = '1';
}
// Defer to vitest CLI with passed arguments.
import('vitest/node').then(m => {
  // When running via node script, simply spawn the CLI programmatically is complex; easier to exec.
}).catch(()=>{});
