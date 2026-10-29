import { NextResponse } from 'next/server';

import { AppError } from './rbac';

// Single shared AppError class (re-exported) so `instanceof` checks in handleApiError
// recognise errors thrown from every module (RBAC, auth, storage, services).
export { AppError };

export const SESSION_COOKIE_NAME = 'solob_session';
export const CSRF_COOKIE_NAME = 'solob_csrf';
export const CSRF_HEADER_NAME = 'x-solob-csrf';

export function parseCookiesHeader(cookieHeader: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Enforces CSRF protection on state-changing HTTP requests (POST, PUT, PATCH, DELETE).
 * 1. Validates Origin / Referer host alignment when present.
 * 2. Blocks cross-site Fetch Metadata requests (`Sec-Fetch-Site: cross-site`).
 * 3. Requires custom `X-Solob-CSRF` header on cookie-authenticated requests and validates
 *    double-submit match when `solob_csrf` cookie is present.
 */
export function enforceCsrfProtection(req: Request): void {
  const method = (req.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return;
  }

  let expectedHost = req.headers.get('host');
  if (!expectedHost) {
    try {
      expectedHost = new URL(req.url).host;
    } catch {
      expectedHost = 'localhost:3000';
    }
  }

  const origin = req.headers.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError(
        'Malformed Origin header on state-changing request.',
        403,
        'CSRF_VALIDATION_FAILED'
      );
    }
    if (originHost.toLowerCase() !== expectedHost.toLowerCase()) {
      throw new AppError(
        'Cross-origin state-changing request blocked by CSRF policy.',
        403,
        'CSRF_VALIDATION_FAILED'
      );
    }
  }

  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    throw new AppError(
      'Cross-site state-changing request blocked by Fetch Metadata policy.',
      403,
      'CSRF_VALIDATION_FAILED'
    );
  }

  const cookies = parseCookiesHeader(req.headers.get('cookie'));
  const hasSessionCookie = Boolean(cookies[SESSION_COOKIE_NAME]);
  const csrfCookie = cookies[CSRF_COOKIE_NAME];
  const csrfHeader = req.headers.get(CSRF_HEADER_NAME)?.trim();

  if (hasSessionCookie) {
    if (!csrfHeader) {
      throw new AppError(
        'Missing required X-Solob-CSRF header on cookie-authenticated state-changing request.',
        403,
        'CSRF_VALIDATION_FAILED'
      );
    }
    if (csrfCookie && csrfHeader !== csrfCookie) {
      throw new AppError(
        'CSRF token mismatch between X-Solob-CSRF header and solob_csrf cookie.',
        403,
        'CSRF_VALIDATION_FAILED'
      );
    }
  }
}

/**
 * Central API error handler.
 * Never discloses raw SQL queries, filesystem paths, environment variables, or stack traces
 * on unexpected internal exceptions.
 */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      },
      { status: err.statusCode }
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred.',
      },
    },
    { status: 500 }
  );
}
