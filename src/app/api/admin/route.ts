import { NextResponse } from 'next/server';
import { getAuthenticatedUserFromRequest } from '@/lib/core/auth';
import { getSystemOverviewAndGovernance, toggleFeatureFlag } from '@/lib/core/admin';
import { runSyntheticSeed } from '@/lib/db/seed';
import { handleApiError } from '@/lib/core/http';
import { AppError } from '@/lib/core/rbac';

export async function GET(req: Request) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    const overview = await getSystemOverviewAndGovernance(user);
    return NextResponse.json({ ok: true, overview });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'toggle_flag') {
      const updated = await toggleFeatureFlag(user, {
        key: body.key,
        enabled: Boolean(body.enabled),
      });
      return NextResponse.json({ ok: true, flag: updated });
    }

    if (action === 'seed_synthetic') {
      const result = await runSyntheticSeed();
      return NextResponse.json({ ok: true, seedResult: result });
    }

    throw new AppError(`Unknown admin action '${action}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
