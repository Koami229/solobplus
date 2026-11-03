import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { validateRuntimeSecurityConfig } from '../core/config';

export interface QueryResultRow {
  [column: string]: any;
}

export interface DbQueryResult<T = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseAdapter {
  readonly engineType: 'pg-pool' | 'pglite';
  query<T = QueryResultRow>(sql: string, params?: any[]): Promise<DbQueryResult<T>>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** Runs `fn` inside a single BEGIN/COMMIT transaction on one dedicated connection (ROLLBACK on error). */
  transaction<T>(fn: (tx: TxQueryable) => Promise<T>): Promise<T>;
}

export interface TxQueryable {
  query<T = QueryResultRow>(sql: string, params?: any[]): Promise<DbQueryResult<T>>;
}

class PgPoolAdapter implements DatabaseAdapter {
  public readonly engineType = 'pg-pool' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  async query<T = QueryResultRow>(sql: string, params: any[] = []): Promise<DbQueryResult<T>> {
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

  async transaction<T>(fn: (tx: TxQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: TxQueryable = {
        query: async <R = QueryResultRow>(sql: string, params: any[] = []) => {
          const r = await client.query(sql, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
        },
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure; original error is rethrown
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

class PGliteAdapter implements DatabaseAdapter {
  public readonly engineType = 'pglite' as const;
  private clientPromise: Promise<PGlite>;

  constructor(dataDir?: string) {
    this.clientPromise = this.init(dataDir);
  }

  private async init(dataDir?: string): Promise<PGlite> {
    if (!dataDir || dataDir === 'memory://' || dataDir === ':memory:') {
      return new PGlite();
    }
    const resolved = path.resolve(process.cwd(), dataDir);
    fs.mkdirSync(resolved, { recursive: true });
    return new PGlite(resolved);
  }

  async query<T = QueryResultRow>(sql: string, params: any[] = []): Promise<DbQueryResult<T>> {
    const client = await this.clientPromise;
    const res = await client.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    const client = await this.clientPromise;
    await client.exec(sql);
  }

  async close(): Promise<void> {
    const client = await this.clientPromise;
    await client.close();
  }

  async transaction<T>(fn: (tx: TxQueryable) => Promise<T>): Promise<T> {
    const client = await this.clientPromise;
    return client.transaction(async (t) =>
      fn({
        query: async <R = QueryResultRow>(sql: string, params: any[] = []) => {
          const r = await t.query<R>(sql, params);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
      })
    );
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __solobDbAdapter: DatabaseAdapter | undefined;
  // eslint-disable-next-line no-var
  var __solobDbMigrated: boolean | undefined;
}

export function createDatabaseAdapter(customDataDir?: string): DatabaseAdapter {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
    return new PgPoolAdapter(dbUrl);
  }
  const dataDir =
    customDataDir ??
    (process.env.NODE_ENV === 'test'
      ? 'memory://'
      : process.env.PGLITE_DATA_DIR || './data/pgdata');
  return new PGliteAdapter(dataDir);
}

export function getDb(): DatabaseAdapter {
  if (!global.__solobDbAdapter) {
    global.__solobDbAdapter = createDatabaseAdapter();
  }
  return global.__solobDbAdapter;
}

export async function resetDbInstanceForTests(dataDir = 'memory://'): Promise<DatabaseAdapter> {
  if (global.__solobDbAdapter) {
    try {
      await global.__solobDbAdapter.close();
    } catch {
      // ignore close errors on test reset
    }
  }
  const externalTestUrl = process.env.DATABASE_URL?.trim();
  if (process.env.SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET === '1' && externalTestUrl) {
    // Opt-in only: runs the suite against a DISPOSABLE external PostgreSQL via DATABASE_URL.
    // Each reset drops and recreates the `public` schema of that database.
    const pg = new PgPoolAdapter(externalTestUrl);
    await pg.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    global.__solobDbAdapter = pg;
  } else {
    global.__solobDbAdapter = new PGliteAdapter(dataDir);
  }
  global.__solobDbMigrated = false;
  await ensureDbReady(global.__solobDbAdapter);
  return global.__solobDbAdapter;
}

/**
 * Applies SQL migrations and reference baseline catalog (languages, curricula, feature flags).
 * Does NOT insert synthetic demo users or projects.
 * In production mode, fails fast if SESSION_SECRET is missing or insecure.
 */
export async function ensureDbReady(adapter?: DatabaseAdapter): Promise<DatabaseAdapter> {
  validateRuntimeSecurityConfig();

  const db = adapter ?? getDb();
  if (global.__solobDbMigrated && !adapter) {
    return db;
  }

  const migrationsDir = path.resolve(process.cwd(), 'db/migrations');
  const migrationFiles = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : ['001_initial_schema.sql'];

  for (const migFile of migrationFiles) {
    const fullPath = path.join(migrationsDir, migFile);
    const sql = fs.readFileSync(fullPath, 'utf8');
    await db.exec(sql);
    await db.query(
      `INSERT INTO schema_migrations (version, applied_at)
       VALUES ($1, NOW())
       ON CONFLICT (version) DO NOTHING`,
      [migFile]
    );
  }

  await seedReferenceCatalogOnly(db);

  if (!adapter) {
    global.__solobDbMigrated = true;
  }
  return db;
}

async function seedReferenceCatalogOnly(db: DatabaseAdapter): Promise<void> {
  // 1. Languages Registry: Verified vs Unverified explicitly distinguished
  const languages = [
    {
      code: 'fra',
      name: 'French',
      nativeName: 'Français',
      region: 'West & Central Africa / International',
      dialects: ['Standard', 'Français d’Afrique de l’Ouest'],
      schoolVerified: true,
      businessVerified: true,
      notes: 'Official instruction language in Benin and francophone West Africa.',
    },
    {
      code: 'eng',
      name: 'English',
      nativeName: 'English',
      region: 'West & East Africa / International',
      dialects: ['Standard', 'West African English'],
      schoolVerified: true,
      businessVerified: true,
      notes: 'Official instruction and international AI evaluation language.',
    },
    {
      code: 'fon',
      name: 'Fon (Fongbe)',
      nativeName: 'Fɔngbè',
      region: 'Benin (Littoral, Atlantique, Zou, Ouémé)',
      dialects: ['Agbome', 'Cotonou', 'Kpase', 'Porto-Novo (Gungbe-adjacent)'],
      schoolVerified: true,
      businessVerified: true,
      notes: 'Verified SOLOB+ national language corpus and assessment pipeline.',
    },
    {
      code: 'yor',
      name: 'Yoruba',
      nativeName: 'Èdè Yorùbá',
      region: 'Nigeria, Benin (Plateau, Collines), Togo',
      dialects: ['Standard Yoruba', 'Idatcha', 'Nago', 'Oyo/Ibadan'],
      schoolVerified: true,
      businessVerified: true,
      notes: 'Verified SOLOB+ tonal transcription and linguistic validation pipeline.',
    },
    {
      code: 'wol',
      name: 'Wolof',
      nativeName: 'Wolof',
      region: 'Senegal, Gambia',
      dialects: ['Dakar Urban', 'Cayor', 'Baol'],
      schoolVerified: false,
      businessVerified: true,
      notes: 'Verified for SOLOB Business annotation; School curriculum alignment pending verification.',
    },
    {
      code: 'hau',
      name: 'Hausa',
      nativeName: 'Harshen Hausa',
      region: 'Nigeria, Niger, Benin (Alibori/Borgou)',
      dialects: ['Kano (Standard)', 'Sokoto', 'Zaria'],
      schoolVerified: false,
      businessVerified: false,
      notes: 'Unverified experimental language pack — requires human linguist sign-off before verified tagging.',
    },
  ];

  for (const lang of languages) {
    await db.query(
      `INSERT INTO languages_registry (
         code, name, native_name, region, dialects_json, school_verified, business_verified, notes
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (code) DO UPDATE SET
         school_verified = EXCLUDED.school_verified,
         business_verified = EXCLUDED.business_verified,
         dialects_json = EXCLUDED.dialects_json`,
      [
        lang.code,
        lang.name,
        lang.nativeName,
        lang.region,
        JSON.stringify(lang.dialects),
        lang.schoolVerified,
        lang.businessVerified,
        lang.notes,
      ]
    );
  }

  // 2. Academic Curricula, Levels & Subjects (explicitly distinguishing verified vs unverified)
  const curricula = [
    {
      id: 'cur_bj_bac',
      code: 'BJ-BAC-GENERAL',
      name: 'Programme National du Bénin — Enseignement Secondaire Général (BAC)',
      country: 'BJ',
      system: 'Francophone / DOB Bénin',
      verified: true,
      description: 'Programme officiel vérifié (Séries C, D, A) aligné sur les exigences du Baccalauréat béninois.',
    },
    {
      id: 'cur_waec_wassce',
      code: 'WAEC-WASSCE',
      name: 'West African Senior School Certificate Examination (WASSCE)',
      country: 'NG',
      system: 'Anglophone / WAEC',
      verified: true,
      description: 'Verified regional syllabus for Senior Secondary School (SS1–SS3) in West Africa.',
    },
    {
      id: 'cur_sn_uemoa_draft',
      code: 'SN-BAC-UEMOA',
      name: 'Programme Régional Harmonisé UEMOA (Sénégal / Côte d’Ivoire)',
      country: 'SN',
      system: 'Francophone / UEMOA',
      verified: false,
      description: 'Programme en cours d’homologation académique — non vérifié (affiché avec avertissement explicite).',
    },
  ];

  for (const c of curricula) {
    await db.query(
      `INSERT INTO academic_curricula (id, code, name, country, education_system, verified, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET verified = EXCLUDED.verified`,
      [c.id, c.code, c.name, c.country, c.system, c.verified, c.description]
    );
  }

  const levels = [
    { id: 'lvl_bj_2nde', curriculumId: 'cur_bj_bac', code: '2NDE', name: 'Seconde Scientifique & Littéraire', order: 1, verified: true },
    { id: 'lvl_bj_1ere', curriculumId: 'cur_bj_bac', code: '1ERE', name: 'Première (Séries C / D / A)', order: 2, verified: true },
    { id: 'lvl_bj_tle_cd', curriculumId: 'cur_bj_bac', code: 'TLE-CD', name: 'Terminale Scientifique (Séries C & D)', order: 3, verified: true },
    { id: 'lvl_waec_ss3', curriculumId: 'cur_waec_wassce', code: 'SS3', name: 'Senior Secondary 3 (Final Exam)', order: 3, verified: true },
    { id: 'lvl_sn_tle_unverified', curriculumId: 'cur_sn_uemoa_draft', code: 'TLE-S2', name: 'Terminale S2 (Non vérifié)', order: 3, verified: false },
  ];

  for (const l of levels) {
    await db.query(
      `INSERT INTO academic_levels (id, curriculum_id, code, name, stage_order, verified)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [l.id, l.curriculumId, l.code, l.name, l.order, l.verified]
    );
  }

  const subjects = [
    { id: 'sub_bj_math', curriculumId: 'cur_bj_bac', levelId: 'lvl_bj_tle_cd', code: 'MATH-TLE', name: 'Mathématiques (Analyse, Algèbre & Probabilités)', category: 'STEM', verified: true },
    { id: 'sub_bj_pct', curriculumId: 'cur_bj_bac', levelId: 'lvl_bj_tle_cd', code: 'PCT-TLE', name: 'Physique, Chimie et Technologie (PCT)', category: 'STEM', verified: true },
    { id: 'sub_bj_svt', curriculumId: 'cur_bj_bac', levelId: 'lvl_bj_tle_cd', code: 'SVT-TLE', name: 'Sciences de la Vie et de la Terre (Génétique & Physiologie)', category: 'STEM', verified: true },
    { id: 'sub_bj_philo', curriculumId: 'cur_bj_bac', levelId: 'lvl_bj_tle_cd', code: 'PHILO-TLE', name: 'Philosophie & Pensée Critique Africaine', category: 'Humanities', verified: true },
    { id: 'sub_waec_math', curriculumId: 'cur_waec_wassce', levelId: 'lvl_waec_ss3', code: 'WAEC-MATH', name: 'Further Mathematics & Core Calculus', category: 'STEM', verified: true },
    { id: 'sub_sn_phys_unverified', curriculumId: 'cur_sn_uemoa_draft', levelId: 'lvl_sn_tle_unverified', code: 'SN-PHYS-DRAFT', name: 'Sciences Physiques UEMOA (Brouillon non vérifié)', category: 'STEM', verified: false },
  ];

  for (const s of subjects) {
    await db.query(
      `INSERT INTO academic_subjects (id, curriculum_id, level_id, code, name, category, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.curriculumId, s.levelId, s.code, s.name, s.category, s.verified]
    );
  }

  // 3. Default Feature Flags
  const flags = [
    { key: 'school.grounded_ai_tutor', description: 'Enable source-grounded academic explanations with uncertainty badges', enabled: true, pillar: 'school' },
    { key: 'school.teacher_assessment_builder', description: 'Allow teachers to generate and customize marking rubrics', enabled: true, pillar: 'school' },
    { key: 'business.explainable_talent_matching', description: 'Enable explainable multi-factor language/skill matching for operators', enabled: true, pillar: 'business' },
    { key: 'business.live_payment_transfers', description: 'Live payment provider transfers (MUST remain disabled unless certified provider is configured)', enabled: false, pillar: 'business' },
    { key: 'core.strict_audit_redaction', description: 'Automatically redact secrets, tokens, and passwords in audit logs', enabled: true, pillar: 'core' },
  ];

  for (const f of flags) {
    await db.query(
      `INSERT INTO feature_flags (key, description, enabled, pillar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [f.key, f.description, f.enabled, f.pillar]
    );
  }
}
