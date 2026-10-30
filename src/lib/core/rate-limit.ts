import { ensureDbReady } from '@/lib/db';
import { sha256Hex } from './crypto';
import { AppError } from './http';
import {
  constantTimeSecretEquals,
  PROXY_SECRET_HEADER,
  validateProxyConfig,
  validateRateLimitConfig,
} from './config';

interface RateBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, RateBucket>();

const IPV4_OR_IPV6_REGEX = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * Extracts a client IP or network identifier safely.
 * - Forwarding headers (`x-forwarded-for`, `x-real-ip`) are trusted ONLY when `TRUST_PROXY=true` AND the
 *   request carries the canonical `x-solob-proxy-secret` header matching `TRUSTED_PROXY_SECRET`
 *   (constant-time comparison). Outside production, `TRUST_PROXY=true` without a configured secret is
 *   accepted for local experiments only; production startup rejects that configuration.
 * - If proxy authentication fails, forwarding headers are ignored entirely.
 * - With `TRUSTED_PROXY_HOPS=N`, the client IP is the N-th entry from the RIGHT of `X-Forwarded-For`
 *   (each trusted proxy appends the address it received the connection from), so client-supplied
 *   left-side entries cannot spoof the bucket.
 * - Never collapses all production clients onto a static `'127.0.0.1'` bucket.
 */
export function extractTrustedClientIp(req?: Request | null): string {
  if (!req) {
    return 'internal-service-context';
  }

  const cfg = validateProxyConfig();
  const isProd = process.env.NODE_ENV === 'production';
  let proxyAuthenticated = false;
  if (cfg.trustProxy) {
    if (cfg.secret) {
      proxyAuthenticated = constantTimeSecretEquals(req.headers.get(PROXY_SECRET_HEADER), cfg.secret);
    } else {
      proxyAuthenticated = !isProd;
    }
  }

  if (proxyAuthenticated) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff
        .split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0);
      if (hops.length >= cfg.hops) {
        const candidate = hops[hops.length - cfg.hops];
        if (IPV4_OR_IPV6_REGEX.test(candidate)) {
          return `proxy-ip:${candidate}`;
        }
      }
    }

    const xRealIp = req.headers.get('x-real-ip')?.trim();
    if (xRealIp && IPV4_OR_IPV6_REGEX.test(xRealIp)) {
      return `proxy-ip:${xRealIp}`;
    }
  }

  // Untrusted path: ignore spoofable forwarding headers completely.
  const ua = req.headers.get('user-agent') || 'unknown-ua';
  const acceptLang = req.headers.get('accept-language') || 'unknown-lang';
  const host = req.headers.get('host') || 'unknown-host';
  const fp = sha256Hex(`${host}|${ua}|${acceptLang}`).slice(0, 20);
  return `direct-client:${fp}`;
}

/**
 * Single atomic PostgreSQL statement: increments the bucket or resets it when the window expired,
 * using the database clock so that all application instances share one time source.
 * Concurrent callers are serialized by the row lock taken by INSERT ... ON CONFLICT DO UPDATE,
 * so no more than `maxRequests` requests can be admitted per window.
 */
const ATOMIC_RATE_LIMIT_SQL = `
INSERT INTO rate_limit_buckets AS b (bucket_key, hit_count, window_start, window_ms, updated_at)
VALUES ($1, 1, clock_timestamp(), $2, clock_timestamp())
ON CONFLICT (bucket_key) DO UPDATE SET
  hit_count = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN 1
    ELSE LEAST(b.hit_count + 1, $3::integer + 1)
  END,
  window_start = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN clock_timestamp()
    ELSE b.window_start
  END,
  window_ms = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN EXCLUDED.window_ms
    ELSE b.window_ms
  END,
  updated_at = clock_timestamp()
RETURNING hit_count,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_start + (window_ms * INTERVAL '1 millisecond') - clock_timestamp())) * 1000))::bigint AS retry_after_ms`;

export async function checkRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const { key, maxRequests, windowMs } = params;

  let row: { hit_count: number; retry_after_ms: number | string } | undefined;
  try {
    const db = await ensureDbReady();
    const res = await db.query<{ hit_count: number; retry_after_ms: number | string }>(
      ATOMIC_RATE_LIMIT_SQL,
      [key, windowMs, maxRequests]
    );
    row = res.rows[0];
    if (!row) throw new Error('rate limit statement returned no row');
  } catch (err) {
    if (err instanceof AppError) throw err; // configuration errors are never masked
    const { allowMemoryFallback } = validateRateLimitConfig();
    if (!allowMemoryFallback) {
      // Fail closed: never silently switch to independent per-instance counters in production.
      throw new AppError(
        'Rate limiting service is temporarily unavailable. Please retry later.',
        503,
        'RATE_LIMIT_UNAVAILABLE'
      );
    }
    return memoryFallback(key, maxRequests, windowMs);
  }

  const hits = Number(row.hit_count);
  if (hits > maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(100, Number(row.retry_after_ms)) };
  }
  return { allowed: true, remaining: Math.max(0, maxRequests - hits), retryAfterMs: 0 };
}

/** Development/test-only per-instance fallback (never used in production). */
function memoryFallback(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = memoryBuckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= maxRequests) {
    const oldest = bucket.timestamps[0] ?? now;
    memoryBuckets.set(key, bucket);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(100, oldest + windowMs - now) };
  }

  bucket.timestamps.push(now);
  memoryBuckets.set(key, bucket);
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - bucket.timestamps.length),
    retryAfterMs: 0,
  };
}

export async function enforceRateLimit(
  key: string,
  maxRequests = 30,
  windowMs = 60_000
): Promise<void> {
  const res = await checkRateLimit({ key, maxRequests, windowMs });
  if (!res.allowed) {
    throw new AppError(
      `Rate limit exceeded. Please retry after ${Math.ceil(res.retryAfterMs / 1000)}s.`,
      429,
      'RATE_LIMITED'
    );
  }
}

export function clearInMemoryRateLimitCacheOnly(): void {
  memoryBuckets.clear();
}

export async function resetAllRateLimits(): Promise<void> {
  memoryBuckets.clear();
  try {
    const db = await ensureDbReady();
    await db.query(`DELETE FROM rate_limit_buckets`);
  } catch {
    // Ignore if DB is not yet initialized
  }
}
