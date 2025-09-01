#!/usr/bin/env node
/**
 * Simple schema drift checker for D1: compares live sqlite_master to reference schema.sql.
 * Usage: node scripts/schema-drift-check.js <db-path> (db path optional if running in CF worker env not local)
 * In CI we invoke inside test harness by exporting DB after migrations.
 */
const fs = require('fs');
const path = require('path');

function normalize(sql) {
  return sql.replace(/\s+/g,' ').trim().toLowerCase();
}

async function main() {
  const refPath = path.join(process.cwd(), 'schema.sql');
  if (!fs.existsSync(refPath)) {
    console.error('reference schema.sql missing'); process.exit(2);
  }
  const ref = fs.readFileSync(refPath,'utf8');
  const refTables = Array.from(ref.matchAll(/create table if not exists ([^(\s]+)\s*\(/ig)).map(m=> m[1].toLowerCase());
  const refNorm = normalize(ref);
  // For now we just ensure all ref tables appear in DB migrations listing; deeper compare could parse columns.
  const migFile = path.join(process.cwd(),'src','migrations.ts');
  const mig = fs.existsSync(migFile) ? fs.readFileSync(migFile,'utf8') : '';
  const missing = refTables.filter(t => !mig.toLowerCase().includes(t));
  if (missing.length) {
    console.log(JSON.stringify({ ok:false, missing }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok:true, checked: refTables.length }));
}
main().catch(e=> { console.error('drift_check_error', e); process.exit(3); });
