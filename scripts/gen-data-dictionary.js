#!/usr/bin/env node
// Generates DATA_DICTIONARY.md from live schema (best-effort) when running in a wrangler dev context.
// For now we parse schema.sql as a fallback (since D1 introspection at build-time is limited).
import fs from 'node:fs';

function parseSchema(sql) {
  const tables = [];
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+) \(([^;]+?)\);/gms;
  let m; while ((m = tableRegex.exec(sql))) {
    const name = m[1];
    const body = m[2];
    const cols = [];
    for (const line of body.split(/\n/).map(l=> l.trim()).filter(Boolean)) {
      if (line.startsWith('--')) continue;
      if (/^PRIMARY KEY/i.test(line)) continue;
      const colMatch = line.match(/^(\w+)\s+([A-Z]+)(.*)$/i);
      if (colMatch) {
        const col = colMatch[1];
        const type = colMatch[2];
        const notes = colMatch[3].replace(/,--.*/,'').trim();
        cols.push({ col, type, notes: notes || '' });
      }
    }
    tables.push({ name, cols });
  }
  return tables;
}

const schemaPath = 'schema.sql';
const outPath = 'DATA_DICTIONARY.md';
const schema = fs.readFileSync(schemaPath, 'utf8');
const tables = parseSchema(schema);
let out = '## Data Dictionary (Automated Extract)\n\nGenerated: ' + new Date().toISOString() + '\n\n';
for (const t of tables) {
  out += `### Table: ${t.name}\n`;
  out += 'Column | Type | Notes\n';
  out += '------ | ---- | -----\n';
  for (const c of t.cols) out += `${c.col} | ${c.type} | ${c.notes}\n`;
  out += '\n';
}
out += '\n(Do not edit manually – run `npm run data:dict` to regenerate.)\n';
fs.writeFileSync(outPath, out);
console.log('Updated DATA_DICTIONARY.md with', tables.length, 'tables.');
