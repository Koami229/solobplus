import { ensureDbReady } from '@/lib/db';
import {
  createId,
  generateSessionToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
  verifySessionTokenFormat,
} from './crypto';
import {
  AppError,
  AuthenticatedUser,
  Pillar,
  resolvePillarForRole,
  UserRole,
} from './rbac';
import { recordAuditEvent } from './audit';
import { enforceRateLimit } from './rate-limit';
import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  fullName: z.string().min(2).max(120),
  role: z.enum(['student', 'teacher', 'org_client', 'contributor', 'reviewer', 'operator', 'admin']),
  preferredUiLang: z.enum(['fr', 'en']).optional().default('fr'),
  countryCode: z.string().min(2).max(5).optional().default('BJ'),
  voiceDataConsent: z.boolean().optional().default(false),
  linguisticDataConsent: z.boolean().optional().default(false),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface SessionResult {
  user: AuthenticatedUser;
  sessionToken: string;
  expiresAt: string;
}

export async function registerUser(
  rawInput: z.input<typeof RegisterSchema>,
  ipAddress = '127.0.0.1'
): Promise<SessionResult> {
  enforceRateLimit(`auth:register:${ipAddress}`, 25, 60_000);
  const parsed = RegisterSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(parsed.error.issues.map((i) => i.message).join('; '), 400, 'VALIDATION_ERROR');
  }
  const input = parsed.data;
  const emailNormalized = input.email.trim().toLowerCase();
  const db = await ensureDbReady();

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [emailNormalized]
  );
  if (existing.rows.length > 0) {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: input.role,
      pillar: resolvePillarForRole(input.role),
      action: 'USER_REGISTER_DUPLICATE',
      targetType: 'USER',
      status: 'DENIED',
      metadata: { email: emailNormalized, password: input.password },
      ipAddress,
    });
    throw new AppError('An account with this email already exists.', 409, 'EMAIL_EXISTS');
  }

  const userId = createId('usr');
  const passwordHash = hashPassword(input.password);
  const pillar: Pillar = resolvePillarForRole(input.role);

  await db.query(
    `INSERT INTO users (
      id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code,
      voice_data_consent, linguistic_data_consent
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
  const user: AuthenticatedUser = {
    id: userId,
    email: emailNormalized,
    fullName: input.fullName.trim(),
    role: input.role,
    pillar,
    preferredUiLang: input.preferredUiLang,
    countryCode: input.countryCode.toUpperCase(),
    isActive: true,
  };

  await recordAuditEvent({
    actorUserId: userId,
    actorRole: input.role,
    pillar,
    action: 'USER_REGISTER',
    targetType: 'USER',
    targetId: userId,
    status: 'SUCCESS',
    metadata: {
      email: emailNormalized,
      role: input.role,
      pillar,
      password: input.password, // Explicitly passed to verify redaction in audit_events
      sessionToken: session.rawToken,
    },
    ipAddress,
  });

  return {
    user,
    sessionToken: session.rawToken,
    expiresAt: session.expiresAt,
  };
}

export async function loginUser(
  rawInput: z.input<typeof LoginSchema>,
  ipAddress = '127.0.0.1'
): Promise<SessionResult> {
  enforceRateLimit(`auth:login:${ipAddress}`, 30, 60_000);
  const parsed = LoginSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('Invalid email or password format.', 400, 'VALIDATION_ERROR');
  }
  const emailNormalized = parsed.data.email.trim().toLowerCase();
  const db = await ensureDbReady();

  const res = await db.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: UserRole;
    pillar: Pillar;
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
      targetType: 'USER',
      status: 'DENIED',
      metadata: { email: emailNormalized, reason: 'USER_NOT_FOUND', password: parsed.data.password },
      ipAddress,
    });
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const row = res.rows[0];
  const valid = verifyPassword(parsed.data.password, row.password_hash);
  if (!valid) {
    await recordAuditEvent({
      actorUserId: row.id,
      actorRole: row.role,
      pillar: row.pillar,
      action: 'USER_LOGIN_FAILED',
      targetType: 'USER',
      targetId: row.id,
      status: 'DENIED',
      metadata: { email: emailNormalized, reason: 'BAD_PASSWORD', password: parsed.data.password },
      ipAddress,
    });
    throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  if (!row.is_active) {
    throw new AppError('Account is disabled.', 403, 'ACCOUNT_DISABLED');
  }

  const session = await createSessionForUser(row.id, ipAddress);
  const user: AuthenticatedUser = {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    pillar: row.pillar,
    preferredUiLang: row.preferred_ui_lang,
    countryCode: row.country_code,
    isActive: row.is_active,
  };

  await recordAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    pillar: user.pillar,
    action: 'USER_LOGIN',
    targetType: 'SESSION',
    targetId: session.sessionId,
    status: 'SUCCESS',
    metadata: { email: user.email, role: user.role, token: session.rawToken },
    ipAddress,
  });

  return {
    user,
    sessionToken: session.rawToken,
    expiresAt: session.expiresAt,
  };
}

async function createSessionForUser(
  userId: string,
  ipAddress: string
): Promise<{ sessionId: string; rawToken: string; expiresAt: string }> {
  const db = await ensureDbReady();
  const sessionId = createId('ses');
  const { rawToken, tokenHash } = generateSessionToken();
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 24);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userId, tokenHash, ipAddress, expiresAt]
  );

  return { sessionId, rawToken, expiresAt };
}

export async function logoutSession(rawToken: string | null | undefined): Promise<boolean> {
  if (!rawToken) return false;
  const db = await ensureDbReady();
  const tokenHash = sha256Hex(rawToken);
  const existing = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
  if (existing.rows.length === 0) {
    return false;
  }
  const row = existing.rows[0];
  await db.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [row.id]);
  await recordAuditEvent({
    actorUserId: row.user_id,
    actorRole: null,
    pillar: 'core',
    action: 'USER_LOGOUT',
    targetType: 'SESSION',
    targetId: row.id,
    status: 'SUCCESS',
    metadata: { sessionId: row.id },
  });
  return true;
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
    user_id: string;
    email: string;
    full_name: string;
    role: UserRole;
    pillar: Pillar;
    preferred_ui_lang: 'fr' | 'en';
    country_code: string;
    is_active: boolean;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `SELECT s.user_id, s.expires_at, s.revoked_at,
            u.email, u.full_name, u.role, u.pillar, u.preferred_ui_lang, u.country_code, u.is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (!row.is_active) return null;

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

export function extractTokenFromHeaders(headers: Headers): string | null {
  const authHeader = headers.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const customHeader = headers.get('x-solob-session');
  if (customHeader) {
    return customHeader.trim();
  }
  const cookieHeader = headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith('solob_session=')) {
        return decodeURIComponent(c.slice('solob_session='.length));
      }
    }
  }
  return null;
}

export async function getAuthenticatedUserFromRequest(req: Request): Promise<AuthenticatedUser | null> {
  const token = extractTokenFromHeaders(req.headers);
  return authenticateSessionToken(token);
}

export async function updatePrivacyAndConsent(
  user: AuthenticatedUser,
  input: {
    privacyRetentionDays?: number;
    voiceDataConsent?: boolean;
    linguisticDataConsent?: boolean;
    marketingConsent?: boolean;
    preferredUiLang?: 'fr' | 'en';
  }
) {
  const db = await ensureDbReady();
  const retention = input.privacyRetentionDays ?? 365;
  if (retention < 30 || retention > 3650) {
    throw new AppError('Retention period must be between 30 and 3650 days.', 400, 'INVALID_RETENTION');
  }

  await db.query(
    `UPDATE users
     SET privacy_retention_days = COALESCE($2, privacy_retention_days),
         voice_data_consent = COALESCE($3, voice_data_consent),
         linguistic_data_consent = COALESCE($4, linguistic_data_consent),
         marketing_consent = COALESCE($5, marketing_consent),
         preferred_ui_lang = COALESCE($6, preferred_ui_lang),
         updated_at = NOW()
     WHERE id = $1`,
    [
      user.id,
      input.privacyRetentionDays ?? null,
      input.voiceDataConsent ?? null,
      input.linguisticDataConsent ?? null,
      input.marketingConsent ?? null,
      input.preferredUiLang ?? null,
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
    targetType: 'USER',
    targetId: user.id,
    status: 'SUCCESS',
    metadata: input,
  });

  const updated = await db.query(
    `SELECT id, email, full_name, role, pillar, preferred_ui_lang, country_code,
            privacy_retention_days, voice_data_consent, linguistic_data_consent, marketing_consent
     FROM users WHERE id = $1`,
    [user.id]
  );
  return updated.rows[0];
}

export async function exportUserDataPackage(user: AuthenticatedUser) {
  const db = await ensureDbReady();
  const userRow = await db.query(
    `SELECT id, email, full_name, role, pillar, preferred_ui_lang, country_code,
            privacy_retention_days, voice_data_consent, linguistic_data_consent, created_at
     FROM users WHERE id = $1`,
    [user.id]
  );
  const schoolDocs = await db.query(
    `SELECT id, title, word_count, created_at FROM school_documents WHERE user_id = $1`,
    [user.id]
  );
  const activities = await db.query(
    `SELECT id, activity_type, summary, created_at FROM school_learning_activities WHERE user_id = $1`,
    [user.id]
  );
  const talent = await db.query(
    `SELECT id, headline, native_languages_json, dialects_json, consent_voice_dataset, consent_linguistic_corpus
     FROM talent_profiles WHERE user_id = $1`,
    [user.id]
  );

  const reqId = createId('prv');
  await db.query(
    `INSERT INTO privacy_requests (id, user_id, request_type, status, payload_json)
     VALUES ($1, $2, 'DATA_EXPORT', 'COMPLETED', $3::jsonb)`,
    [reqId, user.id, JSON.stringify({ exportedAt: new Date().toISOString() })]
  );

  await recordAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    pillar: 'core',
    action: 'USER_DATA_EXPORTED',
    targetType: 'USER',
    targetId: user.id,
    status: 'SUCCESS',
    metadata: { requestId: reqId },
  });

  return {
    requestId: reqId,
    exportedAt: new Date().toISOString(),
    account: userRow.rows[0],
    schoolDocuments: schoolDocs.rows,
    learningActivities: activities.rows,
    talentProfile: talent.rows[0] || null,
  };
}
