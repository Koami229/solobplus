import crypto from 'crypto';
import { validateSessionSecretConfig } from './crypto';
import { AppError } from './rbac';

/** Canonical header the trusted reverse proxy injects to authenticate itself. */
export const PROXY_SECRET_HEADER = 'x-solob-proxy-secret';

export const MIN_PROXY_SECRET_LENGTH = 32;

const PROXY_SECRET_PLACEHOLDER_SUBSTRINGS = ['replace_with', 'changeme', 'change_me', 'example', 'placeholder'];

export interface ProxyConfig {
  trustProxy: boolean;
  hops: number;
  secret: string;
}

type Env = Record<string, string | undefined>;

/**
 * Validates reverse-proxy trust configuration. Fails fast (throws) on invalid configuration.
 * - TRUST_PROXY must be exactly 'true' or 'false' (or unset).
 * - TRUSTED_PROXY_HOPS must be a positive integer (1..10) when set.
 * - In production, TRUST_PROXY=true REQUIRES a TRUSTED_PROXY_SECRET of >= 32 chars that is not a placeholder.
 * - Outside production, a configured secret must still meet the same policy (no weak secrets anywhere).
 */
export function validateProxyConfig(env: Env = process.env): ProxyConfig {
  const isProd = env.NODE_ENV === 'production';
  const rawTrust = (env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (rawTrust !== '' && rawTrust !== 'true' && rawTrust !== 'false') {
    throw new AppError('FATAL: TRUST_PROXY must be "true" or "false".', 500, 'INVALID_PROXY_CONFIG');
  }
  const trustProxy = rawTrust === 'true';

  const rawHops = (env.TRUSTED_PROXY_HOPS ?? '').trim();
  let hops = 1;
  if (rawHops !== '') {
    if (!/^[0-9]+$/.test(rawHops) || Number(rawHops) < 1 || Number(rawHops) > 10) {
      throw new AppError(
        'FATAL: TRUSTED_PROXY_HOPS must be a positive integer between 1 and 10.',
        500,
        'INVALID_PROXY_CONFIG'
      );
    }
    hops = Number(rawHops);
  }

  const secret = (env.TRUSTED_PROXY_SECRET ?? '').trim();
  if (trustProxy && isProd && !secret) {
    throw new AppError(
      'FATAL: TRUST_PROXY=true in production requires a non-empty TRUSTED_PROXY_SECRET.',
      500,
      'INVALID_PROXY_CONFIG'
    );
  }
  if (secret) {
    const lower = secret.toLowerCase();
    if (
      secret.length < MIN_PROXY_SECRET_LENGTH ||
      PROXY_SECRET_PLACEHOLDER_SUBSTRINGS.some((s) => lower.includes(s)) ||
      new Set(secret).size < 10
    ) {
      throw new AppError(
        `FATAL: TRUSTED_PROXY_SECRET must be at least ${MIN_PROXY_SECRET_LENGTH} high-entropy characters and not a placeholder.`,
        500,
        'INVALID_PROXY_CONFIG'
      );
    }
  }
  return { trustProxy, hops, secret };
}

/**
 * Whether the rate limiter may fall back to per-instance memory counters when PostgreSQL is unavailable.
 * Never allowed in production. Allowed by default in development/test; RATE_LIMIT_ALLOW_MEMORY_FALLBACK=false disables it.
 */
export function validateRateLimitConfig(env: Env = process.env): { allowMemoryFallback: boolean } {
  const isProd = env.NODE_ENV === 'production';
  const flag = (env.RATE_LIMIT_ALLOW_MEMORY_FALLBACK ?? '').trim().toLowerCase();
  if (flag !== '' && flag !== 'true' && flag !== 'false') {
    throw new AppError(
      'FATAL: RATE_LIMIT_ALLOW_MEMORY_FALLBACK must be "true" or "false".',
      500,
      'INVALID_RATE_LIMIT_CONFIG'
    );
  }
  if (isProd && flag === 'true') {
    throw new AppError(
      'FATAL: RATE_LIMIT_ALLOW_MEMORY_FALLBACK=true is forbidden in production (per-instance counters are not distributed).',
      500,
      'INVALID_RATE_LIMIT_CONFIG'
    );
  }
  return { allowMemoryFallback: !isProd && flag !== 'false' };
}

/** Full startup security configuration check (fail-fast). */
export function validateRuntimeSecurityConfig(env: Env = process.env): void {
  validateSessionSecretConfig(env.SESSION_SECRET, env.NODE_ENV);
  validateProxyConfig(env);
  validateRateLimitConfig(env);
}

/** Constant-time comparison of two secrets of arbitrary length (compares SHA-256 digests). */
export function constantTimeSecretEquals(candidate: string | null | undefined, expected: string): boolean {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(candidate ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b) && typeof candidate === 'string';
}
