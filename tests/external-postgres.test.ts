import { describe, it, expect, beforeEach } from 'vitest';
import { resetDbInstanceForTests, ensureDbReady } from '@/lib/db';
import { checkRateLimit, resetAllRateLimits } from '@/lib/core/rate-limit';
import { bootstrapInitialAdmin, registerUser, loginUser, authenticateSessionToken, logoutSession } from '@/lib/core/auth';

/**
 * Runs ONLY against a real, disposable external PostgreSQL server:
 *   SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET=1 DATABASE_URL=postgresql://... npm test
 * Skipped otherwise (never reported as passed when skipped).
 */
const enabled = process.env.SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET === '1' && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)('External PostgreSQL 16 integration (pg.Pool via DATABASE_URL)', () => {
  beforeEach(async () => {
    await resetDbInstanceForTests();
    await resetAllRateLimits();
  });

  it('EXT-1 uses pg.Pool against a real PostgreSQL 16 server with migrations 001-003 applied', async () => {
    const db = await ensureDbReady();
    expect(db.engineType).toBe('pg-pool');
    const v = await db.query<{ server_version_num: string }>(`SHOW server_version_num`);
    expect(Number(v.rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
    expect(Number(v.rows[0].server_version_num)).toBeLessThan(170000);
    const migs = await db.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`);
    expect(migs.rows.map((r) => r.version)).toEqual(['001_initial_schema.sql', '002_security_hardening.sql', '003_bootstrap_singleton.sql']);
  });

  it('EXT-2 truly concurrent (10 pooled connections) rate limiting admits exactly max', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => checkRateLimit({ key: 'ext:conc', maxRequests: 13, windowMs: 60_000 }))
    );
    expect(results.filter((r) => r.allowed).length).toBe(13);
  });

  it('EXT-3 concurrent bootstrap on separate connections creates exactly one admin', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        bootstrapInitialAdmin({ email: `ext${i}@solob.example`, password: 'Ext#Bootstrap-Secret-2026!', fullName: 'Ext Admin', countryCode: 'BJ' })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const db = await ensureDbReady();
    expect((await db.query(`SELECT id FROM users WHERE role = 'admin'`)).rows.length).toBe(1);
  });

  it('EXT-4 register / login / session revocation round-trip', async () => {
    await registerUser({ email: 'ext.student@example.org', password: 'StrongPassword!2026', fullName: 'Ext Student', role: 'student', preferredUiLang: 'fr', countryCode: 'BJ' });
    const login = await loginUser({ email: 'ext.student@example.org', password: 'StrongPassword!2026' });
    expect((await authenticateSessionToken(login.sessionToken))?.email).toBe('ext.student@example.org');
    await logoutSession(login.sessionToken);
    expect(await authenticateSessionToken(login.sessionToken)).toBeNull();
  });
});
