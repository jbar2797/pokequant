// Simple in-process migration runner for D1.
// Migrations are id + SQL (single statement or multiple separated by ;).
// They are applied exactly once and recorded in migrations_applied.

export interface Migration { id: string; sql: string; description?: string }

// Baseline migration (no-op placeholders) — ensures tracking table exists.
export const migrations: Migration[] = [
  {
    id: '0001_baseline',
    description: 'Baseline schema tracking row (existing tables created lazily elsewhere)',
    sql: '-- baseline no-op' 
  },
];

let MIGRATIONS_RAN = false;

export async function runMigrations(db: D1Database) {
  if (MIGRATIONS_RAN) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS migrations_applied (id TEXT PRIMARY KEY, applied_at TEXT, description TEXT);`).run();
  const existing = await db.prepare(`SELECT id FROM migrations_applied`).all();
  const have = new Set((existing.results||[]).map((r:any)=> String(r.id)));
  for (const m of migrations) {
    if (have.has(m.id)) continue;
    if (m.sql.trim() && !/^--/.test(m.sql.trim())) {
      // Split on ; but ignore inside simple contexts (baseline uses single statement so fine)
      const parts = m.sql.split(/;\s*\n/).map(s=>s.trim()).filter(Boolean);
      for (const p of parts) {
        await db.prepare(p).run();
      }
    }
    await db.prepare(`INSERT INTO migrations_applied (id, applied_at, description) VALUES (?,?,?)`).bind(m.id, new Date().toISOString(), m.description||null).run();
  }
  MIGRATIONS_RAN = true;
}

export async function listMigrations(db: D1Database) {
  try {
    const rs = await db.prepare(`SELECT id, applied_at, description FROM migrations_applied ORDER BY id ASC`).all();
    return rs.results || [];
  } catch {
    return [];
  }
}