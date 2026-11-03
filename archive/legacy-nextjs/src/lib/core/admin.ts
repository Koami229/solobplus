import { ensureDbReady } from '@/lib/db';
import { AppError, AuthenticatedUser, enforceRole } from './rbac';
import { recordAuditEvent } from './audit';

export async function getSystemOverviewAndGovernance(user: AuthenticatedUser | null) {
  const db = await ensureDbReady();

  const languages = await db.query(`SELECT * FROM languages_registry ORDER BY code ASC`);
  const flags = await db.query(`SELECT * FROM feature_flags ORDER BY key ASC`);

  const counts = await db.query<{
    users_count: string;
    school_docs_count: string;
    business_projects_count: string;
    tasks_count: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM users) AS users_count,
      (SELECT COUNT(*)::text FROM school_documents) AS school_docs_count,
      (SELECT COUNT(*)::text FROM business_projects) AS business_projects_count,
      (SELECT COUNT(*)::text FROM business_tasks) AS tasks_count
  `);

  const isProd = process.env.NODE_ENV === 'production';

  let adminDetails: Record<string, any> | null = null;
  if (user && (user.role === 'admin' || user.role === 'operator')) {
    const recentAudits = await db.query(
      `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 40`
    );
    const aiUsage = await db.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COALESCE(SUM(prompt_tokens), 0)::int AS total_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0)::int AS total_completion_tokens,
         COALESCE(SUM(estimated_cost_usd), 0)::numeric(10,6) AS total_cost_usd
       FROM ai_usage_records`
    );
    const allUsers = await db.query(
      `SELECT id, email, full_name, role, pillar, country_code, is_active, created_at
       FROM users ORDER BY created_at DESC LIMIT 50`
    );

    adminDetails = {
      recentAudits: recentAudits.rows,
      aiUsageSummary: aiUsage.rows[0] ?? null,
      users: allUsers.rows,
    };
  }

  let notifications: any[] = [];
  if (user) {
    const notifRes = await db.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`,
      [user.id]
    );
    notifications = notifRes.rows;
  }

  return {
    engineType: db.engineType,
    environmentStatus: {
      nodeEnv: process.env.NODE_ENV || 'development',
      isProduction: isProd,
      allowSyntheticQuickSwitch: !isProd,
      aiMode:
        process.env.AI_API_KEY && process.env.AI_PROVIDER !== 'mock' ? 'LIVE' : 'MOCK_DEMO',
      paymentMode:
        process.env.PAYMENT_PROVIDER && process.env.PAYMENT_PROVIDER !== 'disabled'
          ? 'SANDBOX_SIMULATED'
          : 'DISABLED_NO_LIVE_TRANSFER',
    },
    counts: counts.rows[0],
    languages: languages.rows,
    featureFlags: flags.rows,
    notifications,
    adminDetails,
  };
}

export async function toggleFeatureFlag(
  user: AuthenticatedUser | null,
  input: { key: string; enabled: boolean }
) {
  const actor = await enforceRole(user, ['admin'], 'core', 'TOGGLE_FEATURE_FLAG');
  const db = await ensureDbReady();

  if (
    input.key === 'business.live_payment_transfers' &&
    input.enabled &&
    (!process.env.PAYMENT_PROVIDER || process.env.PAYMENT_PROVIDER === 'disabled')
  ) {
    throw new AppError(
      'Cannot enable business.live_payment_transfers while PAYMENT_PROVIDER is disabled.',
      400,
      'LIVE_PAYMENT_PROVIDER_DISABLED'
    );
  }

  await db.query(
    `UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE key = $1`,
    [input.key, Boolean(input.enabled)]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'core',
    action: 'FEATURE_FLAG_TOGGLED',
    targetType: 'feature_flag',
    targetId: input.key,
    status: 'SUCCESS',
    metadata: { key: input.key, enabled: input.enabled },
  });

  const updated = await db.query(`SELECT * FROM feature_flags WHERE key = $1`, [input.key]);
  return updated.rows[0];
}
