#!/usr/bin/env node
/**
 * coverage-ratchet.js
 * Increases Vitest coverage thresholds incrementally when the current coverage
 * exceeds existing thresholds by a safety margin. Keeps build red on regression
 * while automatically raising the quality bar over time.
 *
 * Policy:
 *  - Requires a margin >= 2.0 percentage points over the existing threshold
 *  - Bumps each qualifying metric by +1 (never exceeding floor(actualPct))
 *  - Writes updated thresholds back into vitest.config.mts (regex replace)
 *  - Updates the baseline date comment.
 */

import fs from 'fs';
import path from 'path';

const SUMMARY_PATH = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
const CONFIG_PATH = path.join(process.cwd(), 'vitest.config.mts');

function readJSON(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }

function main(){
  if(!fs.existsSync(SUMMARY_PATH)){
    console.error('Coverage summary not found at', SUMMARY_PATH);
    process.exit(1);
  }
  const summary = readJSON(SUMMARY_PATH).total || {};
  const actual = {
    lines: Number(summary.lines?.pct ?? 0),
    functions: Number(summary.functions?.pct ?? 0),
    branches: Number(summary.branches?.pct ?? 0),
    statements: Number(summary.statements?.pct ?? 0)
  };
  let config = fs.readFileSync(CONFIG_PATH,'utf8');
  const current = {};
  for (const k of ['lines','functions','branches','statements']){
    const re = new RegExp(`${k}\\s*:\\s*(\\d+)`, 'm');
    const m = config.match(re);
    if(!m) { console.error('Could not locate threshold for', k); return process.exit(1); }
    current[k] = Number(m[1]);
  }
  const marginNeeded = 2.0; // percentage points
  const bumps = {};
  for (const k of Object.keys(actual)){
    const a = actual[k];
    const c = current[k];
    if (a >= c + marginNeeded){
      const proposed = Math.min(Math.floor(a), c + 1); // conservative +1 ratchet
      if (proposed > c){
  const re = new RegExp(`(${k}\\s*:\\s*)(\\d+)`,'m');
        config = config.replace(re, `$1${proposed}`);
        bumps[k] = { from: c, to: proposed, actual: a };
      }
    }
  }
  if(Object.keys(bumps).length===0){
    console.log('No threshold bumps (insufficient margin). Current:', current, 'Actual:', actual);
    return;
  }
  // Update baseline date comment if present
  const today = new Date().toISOString().slice(0,10);
  config = config.replace(/Ratchet baseline \([^\)]+\)/, `Ratchet baseline (${today})`);
  fs.writeFileSync(CONFIG_PATH, config);
  console.log('Thresholds bumped:');
  for (const [k,v] of Object.entries(bumps)){
    console.log(`  ${k}: ${v.from} -> ${v.to} (actual ${v.actual.toFixed(2)})`);
  }
}

main();
