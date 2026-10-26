import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export interface QueryResult<T = Record<string, any>> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseAdapter {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly engineType: 'postgresql-external' | 'pglite-embedded';
}

declare global {
  // eslint-disable-next-line no-var
  var __solobDbInstance: DatabaseAdapter | undefined;
  // eslint-disable-next-line no-var
  var __solobDbMigrated: boolean | undefined;
}

class PgPoolAdapter implements DatabaseAdapter {
  public readonly engineType = 'postgresql-external' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteAdapter implements DatabaseAdapter {
  public readonly engineType = 'pglite-embedded' as const;
  private client: PGlite;

  constructor(dataDir: string) {
    if (dataDir !== 'memory://' && !dataDir.startsWith('memory://')) {
      const resolved = path.resolve(process.cwd(), dataDir);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      this.client = new PGlite(resolved);
    } else {
      this.client = new PGlite();
    }
  }

  async query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const res = await this.client.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export function getDb(): DatabaseAdapter {
  if (!global.__solobDbInstance) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl && (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://'))) {
      global.__solobDbInstance = new PgPoolAdapter(databaseUrl);
    } else {
      const dataDir = process.env.PGLITE_DATA_DIR?.trim() || './data/pgdata';
      global.__solobDbInstance = new PGliteAdapter(dataDir);
    }
  }
  return global.__solobDbInstance;
}

export async function ensureDbReady(): Promise<DatabaseAdapter> {
  const db = getDb();
  if (!global.__solobDbMigrated) {
    const migrationPath = path.resolve(process.cwd(), 'db/migrations/001_initial_schema.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await db.exec(sql);
      await db.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
        ['001_initial_schema.sql']
      );
    }
    global.__solobDbMigrated = true;
  }
  return db;
}

export async function resetDbInstanceForTests(customDataDir = 'memory://'): Promise<DatabaseAdapter> {
  if (global.__solobDbInstance) {
    try {
      await global.__solobDbInstance.close();
    } catch {
      // ignore close errors during test teardown
    }
  }
  process.env.PGLITE_DATA_DIR = customDataDir;
  delete process.env.DATABASE_URL;
  global.__solobDbInstance = new PGliteAdapter(customDataDir);
  global.__solobDbMigrated = false;
  return ensureDbReady();
}
