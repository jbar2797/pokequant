// Compares current coverage against baseline and fails (exit 1) if any metric drops more than allowed tolerance.
// Usage: node scripts/coverage-ratchet.js [--update] [--tolerance=0.1]
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const covPath = path.join(root, 'coverage', 'coverage-summary.json');
const baselinePath = path.join(root, 'coverage-baseline.json');

const args = process.argv.slice(2);
const update = args.includes('--update');
const tolArg = args.find(a=> a.startsWith('--tolerance='));
const tolerance = tolArg ? parseFloat(tolArg.split('=')[1]) : 0.1; // percentage points

function readJson(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

const cur = readJson(covPath);
if (!cur) { console.error('coverage ratchet: missing current summary at', covPath); process.exit(1); }

const metrics = ['lines','statements','functions','branches'];
const extract = (o) => {
  const out = {};
  for (const m of metrics) {
    const v = o?.total?.[m]?.pct;
    if (typeof v === 'number') out[m] = v;
  }
  return out;
};

const current = extract(cur);
let baseline = readJson(baselinePath);
if (!baseline || typeof baseline !== 'object') baseline = {};

let changed = false;
let failed = false;
const report = [];
for (const m of metrics) {
  const curPct = current[m];
  if (curPct == null) continue;
  const basePct = baseline[m];
  if (basePct == null) { baseline[m] = curPct; changed = true; report.push(`${m}: set baseline ${curPct.toFixed(2)}%`); continue; }
  const drop = basePct - curPct;
  if (drop > tolerance) {
    failed = true;
    report.push(`${m}: FAIL drop ${drop.toFixed(2)} > tolerance ${tolerance} (baseline ${basePct.toFixed(2)} -> current ${curPct.toFixed(2)})`);
  } else if (curPct > basePct) {
    baseline[m] = curPct; changed = true; report.push(`${m}: improved ${basePct.toFixed(2)} -> ${curPct.toFixed(2)} (baseline updated)`);
  } else {
    report.push(`${m}: ok ${curPct.toFixed(2)}% (baseline ${basePct.toFixed(2)}%)`);
  }
}

if (update || !fs.existsSync(baselinePath) || changed) {
  try { fs.writeFileSync(baselinePath, JSON.stringify(baseline,null,2)+'\n'); } catch (e) { console.error('coverage ratchet: cannot write baseline', e); }
}

const summary = report.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Coverage Ratchet\n\n\n${report.map(r=>`- ${r}`).join('\n')}\n`);
}

if (failed) {
  console.error('\nCoverage ratchet failure. Run with --update if intentional.');
  process.exit(1);
}
