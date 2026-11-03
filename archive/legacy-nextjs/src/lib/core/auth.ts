import { z } from 'zod';
import { ensureDbReady } from '@/lib/db';
import {
  createId,
  deriveCsrfToken,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
  verifySessionTokenFormat,
} from './crypto';
import { recordAuditEvent } from './audit';
import { enforceRateLimit } from './rate-limit';
import {
  AppError,
  AuthenticatedUser,
  enforceRole,
  resolvePillarForRole,
  UserRole,
} from './rbac';
import { parseCookiesHeader, SESSION_COOKIE_NAME } from './http';

export const PUBLIC_SELF_REGISTER_ROLES = ['student', 'org_client', 'contributor'] as const;
export const PRIVILEGED_OR_VERIFIED_ROLES = ['admin', 'operator', 'reviewer', 'teacher'] as const;
export const ALL_USER_ROLES = [
  'student',
  'teacher',
  'org_client',
  'contributor',
  'reviewer',
  'operator',
  'admin',
] as const;

export const RegisterSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(8).max(128),
  fullName: z.string().min(2).max(120),
  role: z.enum(PUBLIC_SELF_REGISTER_ROLES),
  preferredUiLang: z.enum(['fr', 'en']).default('fr'),
  countryCode: z.string().min(2).max(4).default('BJ'),
  voiceDataConsent: z.boolean().default(false),
  linguisticDataConsent: z.boolean().default(false),
});

export const FullUserProvisionSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(8).max(128),
  fullName: z.string().min(2).max(120),
  role: z.enum(ALL_USER_ROLES),
  preferredUiLang: z.enum(['fr', 'en']).default('fr'),
  countryCode: z.string().min(2).max(4).default('BJ'),
  voiceDataConsent: z.boolean().default(false),
  linguisticDataConsent: z.boolean().default(false),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const KNOWN_SYNTHETIC_PASSWORD = 'SolobSynthetic#2026';

export function isSyntheticEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@synthetic.solob.local');
}

async function insertUserAndCreateSession(
  input: z.infer<typeof FullUserProvisionSchema>,
  ipAddress: string,
  auditAction: string
): Promise<{
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}> {
  const db = await ensureDbReady();
  const emailNormalized = input.email.trim().toLowerCase();

  if (process.env.NODE_ENV === 'production' && isSyntheticEmail(emailNormalized)) {
    throw new AppError(
      'Synthetic domain accounts are strictly forbidden in production.',
      403,
      'SYNTHETIC_ACCOUNT_FORBIDDEN_IN_PROD'
    );
  }

  const existing = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
    emailNormalized,
  ]);
  if (existing.rows.length > 0) {
    throw new AppError(
      'An account with this email already exists.',
      409,
      'EMAIL_ALREADY_EXISTS'
    );
  }

  const userId = createId('usr');
  const passwordHash = hashPassword(input.password);
  const pillar = resolvePillarForRole(input.role);

  await db.query(
    `INSERT INTO users (
       id, email, password_hash, full_name, role, pillar,
       preferred_ui_lang, country_code, voice_data_consent, linguistic_data_consent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      emailNormalized,
      passwordHash,
      input.fullName.trim(),
      input.role,
      pillar,
      input.preferredUiLang,
      input.countryCode.toUpperCase(),
      input.voiceDataConsent,
      input.linguisticDataConsent,
    ]
  );

  const session = await createSessionForUser(userId, ipAddress);

  await recordAuditEvent({
    actorUserId: userId,
    actorRole: input.role,
    pillar,
    action: auditAction,
    targetType: 'user',
    targetId: userId,
    status: 'SUCCESS',
    ipAddress,
    metadata: {
      email: emailNormalized,
      role: input.role,
      pillar,
      password: input.password, // Tested to verify automatic redaction in audit_events
      sessionToken: session.rawToken, // Tested to verify automatic redaction
    },
  });

  return {
    user: {
      id: userId,
      email: emailNormalized,
      fullName: input.fullName.trim(),
      role: input.role,
      pillar,
      preferredUiLang: input.preferredUiLang,
      countryCode: input.countryCode.toUpperCase(),
      isActive: true,
    },
    sessionToken: session.rawToken,
    csrfToken: deriveCsrfToken(session.rawToken),
    expiresAt: session.expiresAt,
  };
}

/**
 * Public self-registration entrypoint.
 * Strictly enforces an allowlist of unprivileged self-service roles (`student`, `org_client`, `contributor`).
 * Any attempt to self-register as `admin`, `operator`, `reviewer`, or `teacher` is rejected with 403.
 */
export async function registerUser(
  rawInput: unknown,
  ipAddress = 'internal-service-context'
): Promise<{
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}> {
  const rawObj = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<
    string,
    unknown
  >;
  const rawEmail =
    typeof rawObj.email === 'string' ? rawObj.email.trim().toLowerCase() : 'unknown';

  await enforceRateLimit(`auth:register:client:${ipAddress}`, 15, 60_000);
  if (rawEmail !== 'unknown') {
    await enforceRateLimit(`auth:register:email:${rawEmail}`, 5, 60_000);
  }

  const requestedRole = typeof rawObj.role === 'string' ? rawObj.role.trim() : '';
  if ((PRIVILEGED_OR_VERIFIED_ROLES as readonly string[]).includes(requestedRole)) {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: null,
      pillar: 'core',
      action: 'USER_REGISTER_PRIVILEGED_ROLE_DENIED',
      targetType: 'user',
      status: 'DENIED',
      ipAddress,
      metadata: {
        email: rawEmail,
        attemptedRole: requestedRole,
      },
    });
    throw new AppError(
      `Public self-registration for privileged or verification-required role '${requestedRole}' is forbidden.`,
      403,
      'PRIVILEGED_ROLE_FORBIDDEN'
    );
  }

  const parsed = RegisterSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(
      `Invalid registration input: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      400,
      'VALIDATION_ERROR'
    );
  }

  return insertUserAndCreateSession(parsed.data, ipAddress, 'USER_REGISTER');
}

/**
 * Authenticated administrator/operator provisioning for verified or privileged roles
 * (`teacher`, `reviewer`, `operator`, `admin`).
 * - Only `admin` can provision `admin` or `operator`.
 * - `admin` or `operator` can provision `teacher` or `reviewer`.
 */
export async function provisionVerifiedUser(
  actor: AuthenticatedUser | null,
  rawInput: unknown,
  ipAddress = 'internal-service-context'
): Promise<{
  user: AuthenticatedUser;
}> {
  const parsed = FullUserProvisionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(
      `Invalid user provisioning input: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      400,
      'VALIDATION_ERROR'
    );
  }

  const targetRole = parsed.data.role;
  if (targetRole === 'admin' || targetRole === 'operator') {
    await enforceRole(actor, ['admin'], 'core', 'PROVISION_PRIVILEGED_USER');
  } else {
    await enforceRole(actor, ['admin', 'operator'], 'core', 'PROVISION_VERIFIED_USER');
  }

  const created = await insertUserAndCreateSession(
    parsed.data,
    ipAddress,
    'ADMIN_USER_PROVISIONED'
  );
  // Revoke the immediate session since an admin provisioned this account on behalf of another user
  await logoutSession(created.sessionToken);

  return { user: created.user };
}

/**
 * Secure one-time bootstrap procedure for the initial production administrator.
 * Refuses to execute if an active administrator already exists in the database,
 * and rejects synthetic emails or weak/known demo passwords.
 */
export async function bootstrapInitialAdmin(input: {
  email: string;
  password: string;
  fullName: string;
  countryCode?: string;
}): Promise<AuthenticatedUser> {
  const db = await ensureDbReady();
  const emailNormalized = (input.email || '').trim().toLowerCase();
  const password = input.password || '';
  const fullName = (input.fullName || '').trim();

  if (!emailNormalized || !emailNormalized.includes('@') || isSyntheticEmail(emailNormalized)) {
    throw new AppError(
      'Bootstrap administrator email must be a valid non-synthetic address.',
      400,
      'INVALID_BOOTSTRAP_ADMIN_EMAIL'
    );
  }

  if (
    password.length < 12 ||
    password === KNOWN_SYNTHETIC_PASSWORD ||
    password.toLowerCase().includes('password') ||
    password.toLowerCase().includes('synthetic')
  ) {
    throw new AppError(
      'Bootstrap administrator password must be at least 12 characters and must not use a known demo password.',
      400,
      'WEAK_BOOTSTRAP_ADMIN_PASSWORD'
    );
  }

  if (fullName.length < 2) {
    throw new AppError(
      'Bootstrap administrator full name is required.',
      400,
      'INVALID_BOOTSTRAP_ADMIN_NAME'
    );
  }

  const countryCode = (input.countryCode || 'BJ').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new AppError(
      'Bootstrap administrator country must be an ISO 3166-1 alpha-2 code.',
      400,
      'INVALID_BOOTSTRAP_ADMIN_COUNTRY'
    );
  }

  const alreadyBootstrapped = () =>
    new AppError(
      'An initial administrator already exists. One-time bootstrap cannot be re-run.',
      409,
      'ADMIN_ALREADY_BOOTSTRAPPED'
    );

  const userId = createId('usr');
  const passwordHash = hashPassword(password);
  const pillar = resolvePillarForRole('admin');

  // Concurrency-safe: one transaction serialised by a transaction-scoped advisory lock, plus the
  // `system_bootstrap` singleton PRIMARY KEY (migration 003) as a database-level invariant.
  await db.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('solob_plus_initial_admin_bootstrap'))`);

    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE LIMIT 1`
    );
    const marker = await tx.query<{ bootstrap_key: string }>(
      `SELECT bootstrap_key FROM system_bootstrap WHERE bootstrap_key = 'initial_admin'`
    );
    if (existing.rows.length > 0 || marker.rows.length > 0) {
      throw alreadyBootstrapped();
    }

    const dup = await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [emailNormalized]);
    if (dup.rows.length > 0) {
      throw new AppError('An account with this email already exists.', 409, 'EMAIL_ALREADY_EXISTS');
    }

    await tx.query(
      `INSERT INTO users (
         id, email, password_hash, full_name, role, pillar,
         preferred_ui_lang, country_code, voice_data_consent, linguistic_data_consent
       ) VALUES ($1, $2, $3, $4, 'admin', $5, 'fr', $6, FALSE, FALSE)`,
      [userId, emailNormalized, passwordHash, fullName, pillar, countryCode]
    );

    const claimed = await tx.query<{ bootstrap_key: string }>(
      `INSERT INTO system_bootstrap (bootstrap_key, admin_user_id)
       VALUES ('initial_admin', $1)
       ON CONFLICT (bootstrap_key) DO NOTHING
       RETURNING bootstrap_key`,
      [userId]
    );
    if (claimed.rows.length === 0) {
      throw alreadyBootstrapped(); // rolls back the user insert
    }
  });

  // Audit metadata deliberately contains no password, hash, or secret.
  await recordAuditEvent({
    actorUserId: userId,
    actorRole: 'admin',
    pillar,
    action: 'ADMIN_BOOTSTRAP_INITIAL',
    targetType: 'user',
    targetId: userId,
    status: 'SUCCESS',
    ipAddress: 'cli-bootstrap',
    metadata: { email: emailNormalized, role: 'admin', countryCode },
  });

  return {
    id: userId,
    email: emailNormalized,
    fullName,
    role: 'admin',
    pillar,
    preferredUiLang: 'fr',
    countryCode,
    isActive: true,
  };
}

/**
 * Non-production internal helper for automated test fixtures and local synthetic seeding.
 * Strictly blocked when `NODE_ENV === 'production'`.
 */
export async function createNonProductionInternalUser(
  rawInput: z.input<typeof FullUserProvisionSchema>
): Promise<{
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}> {
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(
      'Internal test/seed user provisioning is strictly forbidden in production.',
      403,
      'FORBIDDEN_IN_PRODUCTION'
    );
  }
  const parsed = FullUserProvisionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(
      `Invalid internal user input: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      400,
      'VALIDATION_ERROR'
    );
  }
  return insertUserAndCreateSession(parsed.data, 'local-test-seed', 'INTERNAL_SEED_USER_CREATE');
}

export async function loginUser(
  rawInput: unknown,
  ipAddress = 'internal-service-context'
): Promise<{
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}> {
  const rawObj = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<
    string,
    unknown
  >;
  const rawEmail =
    typeof rawObj.email === 'string' ? rawObj.email.trim().toLowerCase() : 'unknown';

  await enforceRateLimit(`auth:login:client:${ipAddress}`, 15, 60_000);
  if (rawEmail !== 'unknown') {
    await enforceRateLimit(`auth:login:email:${rawEmail}`, 10, 60_000);
  }

  const parsed = LoginSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('Invalid login credentials format.', 400, 'VALIDATION_ERROR');
  }

  const db = await ensureDbReady();
  const emailNormalized = parsed.data.email.trim().toLowerCase();

  if (process.env.NODE_ENV === 'production' && isSyntheticEmail(emailNormalized)) {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: null,
      pillar: 'core',
      action: 'USER_LOGIN_SYNTHETIC_BLOCKED_IN_PROD',
      targetType: 'user',
      status: 'DENIED',
      ipAddress,
      metadata: { email: emailNormalized },
    });
    throw new AppError(
      'Synthetic demo accounts are disabled in production.',
      403,
      'SYNTHETIC_ACCOUNT_FORBIDDEN_IN_PROD'
    );
  }

  const res = await db.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: UserRole;
    pillar: 'school' | 'business' | 'core';
    preferred_ui_lang: 'fr' | 'en';
    country_code: string;
    is_active: boolean;
  }>(
    `SELECT id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code, is_active
     FROM users WHERE email = $1`,
    [emailNormalized]
  );

  if (res.rows.length === 0) {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: null,
      pillar: 'core',
      action: 'USER_LOGIN_FAILED',
      targetType: 'user',
      status: 'DENIED',
      ipAddress,
      metadata: { email: emailNormalized, reason: 'USER_NOT_FOUND' },
    });
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const row = res.rows[0];
  if (!row.is_active) {
    throw new AppError('Account is deactivated.', 403, 'ACCOUNT_DEACTIVATED');
  }

  const valid = verifyPassword(parsed.data.password, row.password_hash);
  if (!valid) {
    await recordAuditEvent({
      actorUserId: row.id,
      actorRole: row.role,
      pillar: row.pillar,
      action: 'USER_LOGIN_FAILED',
      targetType: 'user',
      targetId: row.id,
      status: 'DENIED',
      ipAddress,
      metadata: { email: emailNormalized, reason: 'BAD_PASSWORD' },
    });
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const session = await createSessionForUser(row.id, ipAddress);

  await recordAuditEvent({
    actorUserId: row.id,
    actorRole: row.role,
    pillar: row.pillar,
    action: 'USER_LOGIN',
    targetType: 'user',
    targetId: row.id,
    status: 'SUCCESS',
    ipAddress,
    metadata: { email: row.email, role: row.role },
  });

  return {
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      pillar: row.pillar,
      preferredUiLang: row.preferred_ui_lang,
      countryCode: row.country_code,
      isActive: true,
    },
    sessionToken: session.rawToken,
    csrfToken: deriveCsrfToken(session.rawToken),
    expiresAt: session.expiresAt,
  };
}

export async function createSessionForUser(
  userId: string,
  ipAddress = 'internal-service-context'
): Promise<{ rawToken: string; expiresAt: string }> {
  const db = await ensureDbReady();
  const { rawToken, tokenHash } = generateSessionToken();
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 168);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const sessionId = createId('ses');

  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, tokenHash, ipAddress, expiresAt]
  );

  return { rawToken, expiresAt };
}

export async function authenticateSessionToken(
  rawToken: string | null | undefined
): Promise<AuthenticatedUser | null> {
  if (!rawToken || !verifySessionTokenFormat(rawToken)) {
    return null;
  }

  const db = await ensureDbReady();
  const tokenHash = sha256Hex(rawToken);

  const res = await db.query<{
    session_id: string;
    expires_at: string;
    revoked_at: string | null;
    user_id: string;
    email: string;
    full_name: string;
    role: UserRole;
    pillar: 'school' | 'business' | 'core';
    preferred_ui_lang: 'fr' | 'en';
    country_code: string;
    is_active: boolean;
  }>(
    `SELECT
       s.id AS session_id,
       s.expires_at,
       s.revoked_at,
       u.id AS user_id,
       u.email,
       u.full_name,
       u.role,
       u.pillar,
       u.preferred_ui_lang,
       u.country_code,
       u.is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.revoked_at || !row.is_active) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  if (process.env.NODE_ENV === 'production' && isSyntheticEmail(row.email)) {
    return null;
  }

  return {
    id: row.user_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    pillar: row.pillar,
    preferredUiLang: row.preferred_ui_lang,
    countryCode: row.country_code,
    isActive: row.is_active,
  };
}

export async function logoutSession(rawToken: string | null | undefined): Promise<boolean> {
  if (!rawToken) return false;
  const db = await ensureDbReady();
  const tokenHash = sha256Hex(rawToken);

  const res = await db.query<{ id: string; user_id: string }>(
    `UPDATE sessions
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, user_id`,
    [tokenHash]
  );

  if (res.rows.length > 0) {
    await recordAuditEvent({
      actorUserId: res.rows[0].user_id,
      pillar: 'core',
      action: 'USER_LOGOUT',
      targetType: 'session',
      targetId: res.rows[0].id,
      status: 'SUCCESS',
    });
    return true;
  }
  return false;
}

/**
 * Extracts session token strictly from the HttpOnly `solob_session` cookie on incoming HTTP requests.
 */
export function extractTokenFromHeaders(headers: Headers): string | null {
  const cookies = parseCookiesHeader(headers.get('cookie'));
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  return null;
}

export async function resolveUserFromRequest(req: Request): Promise<AuthenticatedUser | null> {
  const token = extractTokenFromHeaders(req.headers);
  return authenticateSessionToken(token);
}

export const getAuthenticatedUserFromRequest = resolveUserFromRequest;

export async function updatePrivacyAndConsent(
  user: AuthenticatedUser,
  input: {
    privacyRetentionDays?: number;
    marketingConsent?: boolean;
    voiceDataConsent?: boolean;
    linguisticDataConsent?: boolean;
  }
) {
  const db = await ensureDbReady();
  const retention = input.privacyRetentionDays ?? 365;
  if (retention < 30 || retention > 3650) {
    throw new AppError('Retention days must be between 30 and 3650.', 400, 'INVALID_RETENTION');
  }

  await db.query(
    `UPDATE users
     SET privacy_retention_days = COALESCE($2, privacy_retention_days),
         marketing_consent = COALESCE($3, marketing_consent),
         voice_data_consent = COALESCE($4, voice_data_consent),
         linguistic_data_consent = COALESCE($5, linguistic_data_consent),
         updated_at = NOW()
     WHERE id = $1`,
    [
      user.id,
      input.privacyRetentionDays ?? null,
      input.marketingConsent ?? null,
      input.voiceDataConsent ?? null,
      input.linguisticDataConsent ?? null,
    ]
  );

  const reqId = createId('prv');
  await db.query(
    `INSERT INTO privacy_requests (id, user_id, request_type, status, payload_json)
     VALUES ($1, $2, 'CONSENT_UPDATE', 'COMPLETED', $3::jsonb)`,
    [reqId, user.id, JSON.stringify(input)]
  );

  await recordAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    pillar: 'core',
    action: 'PRIVACY_CONSENT_UPDATED',
    targetType: 'user',
    targetId: user.id,
    status: 'SUCCESS',
    metadata: input,
  });

  return { updated: true, requestId: reqId };
}

export async function exportUserDataPackage(user: AuthenticatedUser) {
  const db = await ensureDbReady();
  const userRow = await db.query(
    `SELECT id, email, full_name, role, pillar, preferred_ui_lang, country_code,
            privacy_retention_days, marketing_consent, voice_data_consent, linguistic_data_consent, created_at
     FROM users WHERE id = $1`,
    [user.id]
  );
  const academicProfile = await db.query(`SELECT * FROM academic_profiles WHERE user_id = $1`, [
    user.id,
  ]);
  const schoolActivities = await db.query(
    `SELECT * FROM school_learning_activities WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id]
  );
  const talentProfile = await db.query(`SELECT * FROM talent_profiles WHERE user_id = $1`, [
    user.id,
  ]);
  const compensations = await db.query(
    `SELECT * FROM compensation_records WHERE contributor_user_id = $1`,
    [user.id]
  );

  const exportId = createId('prv');
  const exportPayload = {
    exportId,
    exportedAt: new Date().toISOString(),
    account: userRow.rows[0] ?? null,
    school: {
      academicProfile: academicProfile.rows[0] ?? null,
      activitiesCount: schoolActivities.rows.length,
      activities: schoolActivities.rows,
    },
    business: {
      talentProfile: talentProfile.rows[0] ?? null,
      compensations: compensations.rows,
    },
  };

  await db.query(
    `INSERT INTO privacy_requests (id, user_id, request_type, status, payload_json)
     VALUES ($1, $2, 'DATA_EXPORT', 'COMPLETED', $3::jsonb)`,
    [exportId, user.id, JSON.stringify({ exportedAt: exportPayload.exportedAt })]
  );

  await recordAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    pillar: 'core',
    action: 'USER_DATA_EXPORTED',
    targetType: 'privacy_request',
    targetId: exportId,
    status: 'SUCCESS',
  });

  return exportPayload;
}
