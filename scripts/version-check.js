#!/usr/bin/env node
// Ensures package.json version, openapi.yaml info.version and src/version.ts APP_VERSION match.
import fs from 'fs';

function fail(msg){ console.error(msg); process.exit(2); }

const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const spec = fs.readFileSync('openapi.yaml','utf8');
const verTs = fs.readFileSync('src/version.ts','utf8');

const pkgVer = pkg.version;
const specVer = (spec.match(/version:\s*([0-9]+\.[0-9]+\.[0-9]+)/)||[])[1];
const tsVer = (verTs.match(/APP_VERSION\s*=\s*'([^']+)'/)||[])[1];

if (!specVer) fail('Could not extract version from openapi.yaml');
if (!tsVer) fail('Could not extract APP_VERSION from src/version.ts');

if (pkgVer !== specVer || pkgVer !== tsVer) {
  fail(`Version mismatch: package.json=${pkgVer} openapi.yaml=${specVer} version.ts=${tsVer}`);
}

console.log('Version check passed:', pkgVer);
