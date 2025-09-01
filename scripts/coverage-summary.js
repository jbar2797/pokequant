// Generates a markdown coverage summary and appends it to GITHUB_STEP_SUMMARY
// Avoids inline bash -e/backtick quoting issues in CI.
import fs from 'fs';

function main() {
  const raw = fs.readFileSync('coverage/coverage-summary.json', 'utf8');
  const json = JSON.parse(raw);
  const fmt = (k) => json.total[k].pct.toFixed(2) + '%';
  const out = `## Coverage Summary\n` +
    `Lines: ${fmt('lines')}\n` +
    `Statements: ${fmt('statements')}\n` +
    `Functions: ${fmt('functions')}\n` +
    `Branches: ${fmt('branches')}\n`;
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, out);
  } else {
    console.log('(local) GITHUB_STEP_SUMMARY not set; printing summary to stdout');
  }
  console.log(out);
}

main();
