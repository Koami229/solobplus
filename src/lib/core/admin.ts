import { ensureDbReady } from '@/lib/db';
import { AuthenticatedUser, enforceRole, OPERATOR_ROLES } from './rbac';
import { recordAuditEvent } from './audit';
import { ensureDefaultSchoolCatalog } from '@/lib/school/service';

export async function ensureDefaultFeatureFlags() {
  const db = await ensureDbReady();
  await db.query(
    `INSERT INTO feature_flags (key, description, enabled, pillar)
     VALUES
       ('school.ai_grounded_tutor', 'Enable document-grounded AI academic explanations with explicit uncertainty indicators', TRUE, 'school'),
       ('school.fact_check_inspector', 'Enable source citation & epistemic uncertainty inspector for students and teachers', TRUE, 'school'),
       ('school.multimodal_labs_preview', 'SOLOB Labs R&D preview flag for future audio/diagram study aids (currently disabled)', FALSE, 'school'),
       ('business.explainable_matching', 'Enable transparent assessment-backed talent matching for African language projects', TRUE, 'business'),
       ('business.strict_language_verification', 'Enforce passed proficiency assessment before assigning contributors to language tasks', TRUE, 'business'),
       ('business.live_payment_transfers', 'Allow live automated real-money transfers (MUST remain FALSE until payment provider is configured & tested)', FALSE, 'business')
     ON CONFLICT (key) DO NOTHING`
  );
}

export async function getSystemOverviewAndGovernance(user: AuthenticatedUser | null) {
  await ensureDefaultFeatureFlags();
  await ensureDefaultSchoolCatalog();
  const db = await ensureDbReady();

  const counts = await db.query<{
    users_count: string;
    school_docs_count: string;
    school_submissions_count: string;
    business_projects_count: string;
    business_tasks_count: string;
    delivery_reports_count: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM users) AS users_count,
      (SELECT COUNT(*)::text FROM school_documents) AS school_docs_count,
      (SELECT COUNT(*)::text FROM school_exercise_submissions) AS school_submissions_count,
      (SELECT COUNT(*)::text FROM business_projects) AS business_projects_count,
      (SELECT COUNT(*)::text FROM business_tasks) AS business_tasks_count,
      (SELECT COUNT(*)::text FROM delivery_reports) AS delivery_reports_count
  `);

  const languages = await db.query(`SELECT * FROM languages_registry ORDER BY name ASC`);
  const curricula = await db.query(`SELECT * FROM academic_curricula ORDER BY verified DESC, name ASC`);
  const flags = await db.query(`SELECT * FROM feature_flags ORDER BY pillar ASC, key ASC`);

  let auditEvents: any[] = [];
  let aiUsage: any[] = [];
  let notifications: any[] = [];

  if (user) {
    const ntfRes = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    );
    notifications = ntfRes.rows;

    if (user.role === 'admin' || user.role === 'operator') {
      const audRes = await db.query(
        `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 50`
      );
      auditEvents = audRes.rows;

      const aiRes = await db.query(
        `SELECT * FROM ai_usage_records ORDER BY created_at DESC LIMIT 50`
      );
      aiUsage = aiRes.rows;
    } else {
      const audRes = await db.query(
        `SELECT * FROM audit_events WHERE actor_user_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [user.id]
      );
      auditEvents = audRes.rows;
    }
  }

  const row = counts.rows[0];
  const aiApiKeyConfigured = Boolean(process.env.AI_API_KEY?.trim());
  const paymentProvider = process.env.PAYMENT_PROVIDER || 'disabled';

  return {
    environmentStatus: {
      databaseEngine: db.engineType,
      aiMode: aiApiKeyConfigured ? 'LIVE' : 'MOCK_DEMO',
      aiProvider: process.env.AI_PROVIDER || 'mock',
      aiModel: process.env.AI_MODEL || 'solob-grounded-tutor-v1',
      paymentProviderStatus:
        paymentProvider === 'disabled' ? 'DISABLED_NO_LIVE_TRANSFER' : paymentProvider,
      storageProvider: process.env.STORAGE_PROVIDER || 'local-private',
    },
    metrics: {
      usersCount: Number(row?.users_count || 0),
      schoolDocumentsCount: Number(row?.school_docs_count || 0),
      schoolSubmissionsCount: Number(row?.school_submissions_count || 0),
      businessProjectsCount: Number(row?.business_projects_count || 0),
      businessTasksCount: Number(row?.business_tasks_count || 0),
      deliveryReportsCount: Number(row?.delivery_reports_count || 0),
    },
    languagesRegistry: languages.rows,
    curriculaRegistry: curricula.rows,
    featureFlags: flags.rows,
    auditEvents,
    aiUsage,
    notifications,
  };
}

export async function toggleFeatureFlag(
  user: AuthenticatedUser | null,
  input: { key: string; enabled: boolean }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'core', 'TOGGLE_FEATURE_FLAG');
  if (input.key === 'business.live_payment_transfers' && input.enabled) {
    const paymentProvider = process.env.PAYMENT_PROVIDER || 'disabled';
    if (paymentProvider === 'disabled') {
      throw new Error(
        'Cannot enable business.live_payment_transfers while PAYMENT_PROVIDER is disabled.'
      );
    }
  }
  const db = await ensureDbReady();
  await db.query(
    `UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE key = $1`,
    [input.key, input.enabled]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'core',
    action: 'FEATURE_FLAG_UPDATED',
    targetType: 'FEATURE_FLAG',
    targetId: input.key,
    status: 'SUCCESS',
    metadata: { key: input.key, enabled: input.enabled },
  });

  const updated = await db.query(`SELECT * FROM feature_flags WHERE key = $1`, [input.key]);
  return updated.rows[0];
}
