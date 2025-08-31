#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const summaryPath = path.resolve('coverage/coverage-summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error('coverage-summary.json not found. Run test:coverage first.');
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath,'utf8'));
const pct = Math.round(summary.total.lines.pct);
const color = pct >= 80 ? '#4c1' : pct >= 70 ? '#97CA00' : pct >= 60 ? '#dfb317' : pct >= 50 ? '#fe7d37' : '#e05d44';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="20" role="img" aria-label="coverage: ${pct}%"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><mask id="m"><rect width="110" height="20" rx="3" fill="#fff"/></mask><g mask="url(#m)"><rect width="62" height="20" fill="#555"/><rect x="62" width="48" height="20" fill="${color}"/><rect width="110" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110"><text aria-hidden="true" x="31" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="520">coverage</text><text x="31" y="140" transform="scale(.1)" fill="#fff" textLength="520">coverage</text><text aria-hidden="true" x="850" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="380">${pct}%</text><text x="850" y="140" transform="scale(.1)" fill="#fff" textLength="380">${pct}%</text></g></svg>`;
const outDir = path.resolve('public');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
fs.writeFileSync(path.join(outDir,'coverage-badge.svg'), svg);
console.log(`Generated coverage-badge.svg for ${pct}%`);