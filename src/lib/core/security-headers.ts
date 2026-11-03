/**
 * HTTP security headers applied to every route (see next.config.ts and SECURITY.md).
 * Static CSP: Next.js App Router injects inline bootstrap scripts, so without a
 * nonce-based middleware 'unsafe-inline' is required for script-src. 'unsafe-eval'
 * is only allowed in development (React Refresh / webpack dev runtime).
 */
export interface SecurityHeader {
  key: string;
  value: string;
}

export function buildContentSecurityPolicy(isProduction: boolean): string {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (!isProduction) scriptSrc.push("'unsafe-eval'");
  const connectSrc = ["'self'"];
  if (!isProduction) connectSrc.push('ws:', 'wss:');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function buildSecurityHeaders(isProduction: boolean): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(isProduction) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
  if (isProduction) {
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' });
  }
  return headers;
}
