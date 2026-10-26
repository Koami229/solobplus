import { AppError } from './rbac';

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const windowStart = now - params.windowMs;
  const bucket = buckets.get(params.key) || { timestamps: [] };

  bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

  if (bucket.timestamps.length >= params.maxRequests) {
    const oldest = bucket.timestamps[0] || now;
    const retryAfterMs = Math.max(100, oldest + params.windowMs - now);
    buckets.set(params.key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }

  bucket.timestamps.push(now);
  buckets.set(params.key, bucket);
  return {
    allowed: true,
    remaining: Math.max(0, params.maxRequests - bucket.timestamps.length),
    retryAfterMs: 0,
  };
}

export function enforceRateLimit(key: string, maxRequests = 30, windowMs = 60_000): void {
  const res = checkRateLimit({ key, maxRequests, windowMs });
  if (!res.allowed) {
    throw new AppError(
      `Rate limit exceeded for '${key}'. Retry after ${Math.ceil(res.retryAfterMs / 1000)}s.`,
      429,
      'RATE_LIMITED'
    );
  }
}

export function resetAllRateLimits(): void {
  buckets.clear();
}
