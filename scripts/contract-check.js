#!/usr/bin/env node
// Contract drift checker: ensures each OpenAPI path exists in source either
// (a) legacy monolith style: url.pathname === '/path'
// (b) modular router style: router.add('METHOD','/path', ...)
// We intentionally treat presence as a simple textual marker (not full parser).
import fs from 'fs';
import path from 'path';

const spec = fs.readFileSync('openapi.yaml','utf8');

// Collect source text from index.ts plus any route modules.
let sources = '';
try { sources += fs.readFileSync('src/index.ts','utf8'); } catch {/* ignore */}
try {
  const routesDir = 'src/routes';
  if (fs.existsSync(routesDir)) {
    for (const f of fs.readdirSync(routesDir)) {
      if (f.endsWith('.ts')) {
        try { sources += '\n' + fs.readFileSync(path.join(routesDir, f),'utf8'); } catch {/* ignore */}
      }
    }
  }
} catch {/* ignore */}

// Extract path keys from spec (very naive YAML scan; sufficient for flat path lines).
const pathRegex = /\n\s{2,}(\/[a-zA-Z0-9_\-\/]+):/g; // matches lines starting with two+ spaces then /path:
const listed = new Set();
let m;
while ((m = pathRegex.exec(spec))) { listed.add(m[1]); }

// Helper to test if an endpoint path is referenced in sources.
function hasPath(p){
  if (sources.includes(`url.pathname === '${p}'`)) return true; // legacy style direct check
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // Pattern 1: router.add('METHOD','/path'
  const add1 = new RegExp(`router\\.add\\(\\s*['\"](?:GET|POST|PUT|DELETE|OPTIONS|PATCH)['\"]\\s*,\\s*['\"]${escaped}['\"]`);
  if (add1.test(sources)) return true;
  // Pattern 2: chained style: .add('METHOD','/path'
  const add2 = new RegExp(`\\.add\\(\\s*['\"](?:GET|POST|PUT|DELETE|OPTIONS|PATCH)['\"]\\s*,\\s*['\"]${escaped}['\"]`);
  if (add2.test(sources)) return true;
  return false;
}

// Evaluate missing markers.
const missing = [];
for (const p of listed) {
  if (!hasPath(p)) missing.push(p);
}

if (missing.length) {
  console.error('Spec endpoints missing implementation markers:', missing.join(', '));
  process.exit(2);
}
console.log('Contract check passed.');
