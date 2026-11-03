/**
 * Next.js startup hook: fail fast on insecure production configuration
 * (SESSION_SECRET, reverse-proxy trust, rate-limit fallback policy) before serving any request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateRuntimeSecurityConfig } = await import('./lib/core/config');
    validateRuntimeSecurityConfig();
  }
}
