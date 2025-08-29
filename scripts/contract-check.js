#!/usr/bin/env node
// Simple contract drift checker: ensures listed endpoints in openapi.yaml exist in source index.ts fetch routes.
import fs from 'fs';

const spec = fs.readFileSync('openapi.yaml','utf8');
const src = fs.readFileSync('src/index.ts','utf8');

const pathRegex = /\n\s{2,}(\/[a-zA-Z0-9_\-\/]+):/g; // naive
const listed = new Set();
let m;
while ((m = pathRegex.exec(spec))) { listed.add(m[1]); }

// Only check major public endpoints (exclude /admin/* unless present)
const missing = [];
for (const p of listed) {
  if (!src.includes(`url.pathname === '${p}'`)) {
    // allow parameterized variations (we don't have path params yet)
    missing.push(p);
  }
}
if (missing.length) {
  console.error('Spec endpoints missing implementation markers:', missing.join(', '));
  process.exit(2);
}
console.log('Contract check passed.');
