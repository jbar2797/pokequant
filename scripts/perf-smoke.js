#!/usr/bin/env node
// Simple performance smoke gate: fetch a few public endpoints locally and assert p95 < threshold (ms)
// Usage: BASE=http://127.0.0.1:8787 node scripts/perf-smoke.js
const fetch = globalThis.fetch || (await import('node-fetch')).default; // Node 20 has global fetch

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ENDPOINTS = [
  '/health',
  '/api/universe',
  '/api/cards',
  '/api/movers?n=4'
];
const ITERATIONS = parseInt(process.env.ITER || '4', 10); // small to keep CI fast
const P95_BUDGET_MS = parseInt(process.env.P95_BUDGET_MS || '450', 10); // budget per endpoint

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a,b)=>a-b);
  const idx = Math.min(sorted.length-1, Math.floor(p/100 * sorted.length));
  return sorted[idx];
}

async function run() {
  let failures = 0;
  for (const ep of ENDPOINTS) {
    const times = [];
    for (let i=0;i<ITERATIONS;i++) {
      const t0 = performance.now();
      const res = await fetch(BASE + ep);
      await res.text(); // drain
      const dur = performance.now() - t0;
      times.push(dur);
    }
    const p95 = percentile(times, 95);
    const p50 = percentile(times, 50);
    const line = `${ep} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (budget ${P95_BUDGET_MS}ms)`;
    if (p95 > P95_BUDGET_MS) { console.error('FAIL', line); failures++; } else { console.log('OK  ', line); }
  }
  if (failures) {
    console.error(`Performance smoke failed: ${failures} endpoint(s) over budget`);
    process.exit(1);
  }
  console.log('Performance smoke passed');
}

run().catch(e=>{ console.error('perf-smoke error', e); process.exit(1); });
