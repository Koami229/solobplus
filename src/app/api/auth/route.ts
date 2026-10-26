import { NextResponse } from 'next/server';
import {
  exportUserDataPackage,
  extractTokenFromHeaders,
  getAuthenticatedUserFromRequest,
  loginUser,
  logoutSession,
  registerUser,
  updatePrivacyAndConsent,
} from '@/lib/core/auth';
import { getSystemOverviewAndGovernance } from '@/lib/core/admin';
import { handleApiError } from '@/lib/core/http';
import { AppError } from '@/lib/core/rbac';

export async function GET(req: Request) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    const overview = await getSystemOverviewAndGovernance(user);
    return NextResponse.json({
      ok: true,
      user,
      overview,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = body?.action;

    if (action === 'register') {
      const result = await registerUser({
        email: body.email,
        password: body.password,
        fullName: body.fullName,
        role: body.role,
        preferredUiLang: body.preferredUiLang || 'fr',
        countryCode: body.countryCode || 'BJ',
        voiceDataConsent: Boolean(body.voiceDataConsent),
        linguisticDataConsent: Boolean(body.linguisticDataConsent),
      });
      const response = NextResponse.json({ ok: true, ...result }, { status: 201 });
      response.cookies.set('solob_session', result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 3600,
      });
      return response;
    }

    if (action === 'login') {
      const result = await loginUser({
        email: body.email,
        password: body.password,
      });
      const response = NextResponse.json({ ok: true, ...result });
      response.cookies.set('solob_session', result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 24 * 3600,
      });
      return response;
    }

    if (action === 'logout') {
      const token = extractTokenFromHeaders(req.headers) || body.sessionToken;
      await logoutSession(token);
      const response = NextResponse.json({ ok: true, loggedOut: true });
      response.cookies.delete('solob_session');
      return response;
    }

    if (action === 'privacy_update') {
      const user = await getAuthenticatedUserFromRequest(req);
      if (!user) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
      const updated = await updatePrivacyAndConsent(user, {
        privacyRetentionDays: body.privacyRetentionDays,
        voiceDataConsent: body.voiceDataConsent,
        linguisticDataConsent: body.linguisticDataConsent,
        marketingConsent: body.marketingConsent,
        preferredUiLang: body.preferredUiLang,
      });
      return NextResponse.json({ ok: true, account: updated });
    }

    if (action === 'data_export') {
      const user = await getAuthenticatedUserFromRequest(req);
      if (!user) throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
      const pkg = await exportUserDataPackage(user);
      return NextResponse.json({ ok: true, exportPackage: pkg });
    }

    throw new AppError(`Unknown auth action '${action}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
