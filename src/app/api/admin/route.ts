import { NextResponse } from 'next/server';
import { provisionVerifiedUser, resolveUserFromRequest } from '@/lib/core/auth';
import { getSystemOverviewAndGovernance, toggleFeatureFlag } from '@/lib/core/admin';
import { AppError, enforceCsrfProtection, handleApiError } from '@/lib/core/http';
import { enforceRole } from '@/lib/core/rbac';
import { enforceRateLimit, extractTrustedClientIp } from '@/lib/core/rate-limit';
import { runSyntheticSeed } from '@/lib/db/seed';

export async function GET(req: Request) {
  try {
    const user = await resolveUserFromRequest(req);
    const overview = await getSystemOverviewAndGovernance(user);
    return NextResponse.json({ ok: true, overview });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    enforceCsrfProtection(req);
    const clientIp = extractTrustedClientIp(req);
    await enforceRateLimit(`api:admin:${clientIp}`, 30, 60_000);

    const user = await resolveUserFromRequest(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'seed_synthetic') {
      if (process.env.NODE_ENV === 'production') {
        throw new AppError(
          'Synthetic account seeding is strictly disabled in production.',
          403,
          'SEED_FORBIDDEN_IN_PRODUCTION'
        );
      }
      await enforceRole(user, ['admin'], 'core', 'SEED_SYNTHETIC');
      const result = await runSyntheticSeed();
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'provision_user') {
      const result = await provisionVerifiedUser(user, body, clientIp);
      return NextResponse.json({ ok: true, user: result.user }, { status: 201 });
    }

    if (action === 'toggle_flag') {
      const flag = await toggleFeatureFlag(user, {
        key: body.key,
        enabled: Boolean(body.enabled),
      });
      return NextResponse.json({ ok: true, flag });
    }

    throw new AppError(`Unknown admin action '${String(action)}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
