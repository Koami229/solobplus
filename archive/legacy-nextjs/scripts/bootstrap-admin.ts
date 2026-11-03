import { bootstrapInitialAdmin } from '../src/lib/core/auth';
import { getDb } from '../src/lib/db/index';

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || '';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'SOLOB+ Platform Administrator';
  const countryCode = process.env.BOOTSTRAP_ADMIN_COUNTRY?.trim() || 'BJ';

  if (!email || !password) {
    const missing = ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD'].join(' and ');
    console.error(`[SOLOB+ Bootstrap Admin] Missing required environment variables: ${missing}.`);
    process.exit(1);
  }

  console.log(`[SOLOB+ Bootstrap Admin] Provisioning initial administrator (${email})...`);
  const admin = await bootstrapInitialAdmin({
    email,
    password,
    fullName,
    countryCode,
  });

  console.log('[SOLOB+ Bootstrap Admin] Initial administrator created successfully:', {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    pillar: admin.pillar,
  });

  await getDb().close();
}

main().catch(async (err) => {
  console.error('[SOLOB+ Bootstrap Admin] Failed:', err instanceof Error ? err.message : err);
  try {
    await getDb().close();
  } catch {
    // ignore
  }
  process.exit(1);
});
