import { ensureDbReady } from '@/lib/db';
import { sha256Hex } from './crypto';
import { AppError } from './http';

interface RateBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, RateBucket>();

const IPV4_OR_IPV6_REGEX = /^[0-9a-fA-F:.]{3,45}$/;

/**
 * Extracts a client IP or network identifier safely:
 * - Only trusts forwarding headers (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`) when
 *   `TRUST_PROXY=true` is explicitly configured (and `TRUSTED_PROXY_SECRET` matches if set).
 * - When `TRUST_PROXY=true` and `x-forwarded-for` contains multiple hops, selects the rightmost
 *   trusted hop (`TRUSTED_PROXY_HOPS`, default 1) rather than the leftmost client-spoofable entry.
 * - Never collapses all production clients onto a static `'127.0.0.1'` bucket.
 */
export function extractTrustedClientIp(req?: Request | null): string {
  if (!req) {
    return 'internal-service-context';
  }

  const trustProxy = process.env.TRUST_PROXY === 'true';
  const requiredProxySecret = process.env.TRUSTED_PROXY_SECRET?.trim();
  const proxySecretValid =
    !requiredProxySecret || req.headers.get('x-proxy-secret') === requiredProxySecret;

  if (trustProxy && proxySecretValid) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff
        .split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0 && IPV4_OR_IPV6_REGEX.test(ip));
      if (hops.length > 0) {
        const configuredHops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || 1));
        const idx = Math.max(0, hops.length - configuredHops);
        return `proxy-ip:${hops[idx]}`;
      }
    }

    const xRealIp = req.headers.get('x-real-ip')?.trim();
    if (xRealIp && IPV4_OR_IPV6_REGEX.test(xRealIp)) {
      return `proxy-ip:${xRealIp}`;
    }

    const cfIp = req.headers.get('cf-connecting-ip')?.trim();
    if (cfIp && IPV4_OR_IPV6_REGEX.test(cfIp)) {
      return `proxy-ip:${cfIp}`;
    }
  }

  // When TRUST_PROXY is not enabled, ignore spoofable forwarding headers completely.
  // Derive a non-global client context identifier from non-forwarding request metadata.
  const ua = req.headers.get('user-agent') || 'unknown-ua';
  const acceptLang = req.headers.get('accept-language') || 'unknown-lang';
  const host = req.headers.get('host') || 'unknown-host';
  const fp = sha256Hex(`${host}|${ua}|${acceptLang}`).slice(0, 20);
  return `direct-client:${fp}`;
}

export async function checkRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const now = Date.now();
  const { key, maxRequests, windowMs } = params;

  try {
    const db = await ensureDbReady();
    const existing = await db.query<{
      bucket_key: string;
      hit_count: number;
      window_start: string;
      window_ms: number;
    }>(
      `SELECT bucket_key, hit_count, window_start, window_ms
       FROM rate_limit_buckets
       WHERE bucket_key = $1`,
      [key]
    );

    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO rate_limit_buckets (bucket_key, hit_count, window_start, window_ms, updated_at)
         VALUES ($1, 1, $2, $3, $2)
         ON CONFLICT (bucket_key) DO UPDATE SET
           hit_count = 1,
           window_start = EXCLUDED.window_start,
           window_ms = EXCLUDED.window_ms,
           updated_at = EXCLUDED.updated_at`,
        [key, new Date(now).toISOString(), windowMs]
      );
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - 1),
        retryAfterMs: 0,
      };
    }

    const row = existing.rows[0];
    const windowStartMs = new Date(row.window_start).getTime();
    const activeWindowMs = Number(row.window_ms || windowMs);

    if (now - windowStartMs >= activeWindowMs) {
      await db.query(
        `UPDATE rate_limit_buckets
         SET hit_count = 1, window_start = $2, window_ms = $3, updated_at = $2
         WHERE bucket_key = $1`,
        [key, new Date(now).toISOString(), windowMs]
      );
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - 1),
        retryAfterMs: 0,
      };
    }

    const currentHits = Number(row.hit_count);
    if (currentHits >= maxRequests) {
      const retryAfterMs = Math.max(100, windowStartMs + activeWindowMs - now);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
    }

    const nextHits = currentHits + 1;
    await db.query(
      `UPDATE rate_limit_buckets
       SET hit_count = $2, updated_at = $3
       WHERE bucket_key = $1`,
      [key, nextHits, new Date(now).toISOString()]
    );

    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - nextHits),
      retryAfterMs: 0,
    };
  } catch {
    // Fallback to in-memory sliding window if database is temporarily unavailable
    const cutoff = now - windowMs;
    const bucket = memoryBuckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= maxRequests) {
      const oldest = bucket.timestamps[0] ?? now;
      const retryAfterMs = Math.max(100, oldest + windowMs - now);
      memoryBuckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    bucket.timestamps.push(now);
    memoryBuckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - bucket.timestamps.length),
      retryAfterMs: 0,
    };
  }
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
