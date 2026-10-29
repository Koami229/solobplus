import { NextResponse } from 'next/server';
import {
  exportUserDataPackage,
  extractTokenFromHeaders,
  loginUser,
  logoutSession,
  registerUser,
  resolveUserFromRequest,
  updatePrivacyAndConsent,
} from '@/lib/core/auth';
import { deriveCsrfToken } from '@/lib/core/crypto';
import {
  AppError,
  CSRF_COOKIE_NAME,
  enforceCsrfProtection,
  handleApiError,
  SESSION_COOKIE_NAME,
} from '@/lib/core/http';
import { extractTrustedClientIp } from '@/lib/core/rate-limit';

function applySessionCookies(
  response: NextResponse,
  sessionToken: string,
  csrfToken: string,
  expiresAt: string
): void {
  const isProd = process.env.NODE_ENV === 'production';
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 168);
  const maxAgeSeconds = Math.max(60, Math.floor(ttlHours * 3600));
  const expiresDate = new Date(expiresAt);

  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
    expires: expiresDate,
  });

  response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
    expires: expiresDate,
  });
}

function clearSessionCookies(response: NextResponse): void {
  const isProd = process.env.NODE_ENV === 'production';
  const epoch = new Date(0);

  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: epoch,
  });

  response.cookies.set(CSRF_COOKIE_NAME, '', {
    httpOnly: false,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: epoch,
  });
}

export async function GET(req: Request) {
  try {
    const user = await resolveUserFromRequest(req);
    const token = extractTokenFromHeaders(req.headers);
    const csrfToken = user && token ? deriveCsrfToken(token) : null;
    const res = NextResponse.json({ ok: true, user, csrfToken });
    if (user && csrfToken) {
      res.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
    }
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    enforceCsrfProtection(req);
    const clientIp = extractTrustedClientIp(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'register') {
      const result = await registerUser(body, clientIp);
      const res = NextResponse.json(
        {
          ok: true,
          user: result.user,
          expiresAt: result.expiresAt,
          csrfToken: result.csrfToken,
        },
        { status: 201 }
      );
      applySessionCookies(res, result.sessionToken, result.csrfToken, result.expiresAt);
      return res;
    }

    if (action === 'login') {
      const result = await loginUser(body, clientIp);
      const res = NextResponse.json({
        ok: true,
        user: result.user,
        expiresAt: result.expiresAt,
        csrfToken: result.csrfToken,
      });
      applySessionCookies(res, result.sessionToken, result.csrfToken, result.expiresAt);
      return res;
    }

    if (action === 'logout') {
      const token = extractTokenFromHeaders(req.headers);
      const revoked = await logoutSession(token);
      const res = NextResponse.json({ ok: true, revoked });
      clearSessionCookies(res);
      return res;
    }

    if (action === 'update_privacy') {
      const user = await resolveUserFromRequest(req);
      if (!user) {
        throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
      }
      const result = await updatePrivacyAndConsent(user, body);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'export_data') {
      const user = await resolveUserFromRequest(req);
      if (!user) {
        throw new AppError('Authentication required.', 401, 'UNAUTHENTICATED');
      }
      const exportPkg = await exportUserDataPackage(user);
      return NextResponse.json({ ok: true, exportPackage: exportPkg });
    }

    throw new AppError(`Unknown auth action '${String(action)}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
