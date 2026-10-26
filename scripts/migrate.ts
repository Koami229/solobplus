import { ensureDbReady } from '../src/lib/db/index';

async function main() {
  console.log('[SOLOB+ Migrate] Starting database schema migration...');
  const db = await ensureDbReady();
  const migrations = await db.query<{ version: string; applied_at: string }>(
    `SELECT version, applied_at FROM schema_migrations ORDER BY version ASC`
  );
  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC`
  );
  console.log(`[SOLOB+ Migrate] Engine: ${db.engineType}`);
  console.log(`[SOLOB+ Migrate] Applied migrations:`, migrations.rows);
  console.log(
    `[SOLOB+ Migrate] Public tables (${tables.rows.length}):`,
    tables.rows.map((t) => t.tablename).join(', ')
  );
  await db.close();
}

main().catch((err) => {
  console.error('[SOLOB+ Migrate] Fatal error:', err);
  process.exit(1);
});
