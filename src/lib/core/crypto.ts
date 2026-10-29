import crypto from 'crypto';
import { AppError } from './http';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

const LOCAL_DEV_ONLY_FALLBACK_SECRET = 'solob-local-dev-only-ephemeral-hmac-key-2026';

const FORBIDDEN_PRODUCTION_SECRETS = new Set([
  'solob-dev-ephemeral-hmac-key-not-for-prod',
  'dev-only-solob-plus-hmac-secret-replace-in-prod-2026',
  'replace_with_64_char_hex_session_secret_do_not_commit',
  LOCAL_DEV_ONLY_FALLBACK_SECRET.toLowerCase(),
]);

const FORBIDDEN_PRODUCTION_SUBSTRINGS = [
  'replace_with',
  'changeme',
  'dev-only',
  'not-for-prod',
  'ephemeral-hmac-key',
  'example-secret',
];

function computeShannonEntropyBitsPerChar(input: string): number {
  if (!input || input.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of input) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = input.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Validates SESSION_SECRET according to the active environment policy.
 * In production (`NODE_ENV === 'production'`), fails fast with a 500 configuration error
 * if SESSION_SECRET is missing, uses a known development/placeholder value, or lacks sufficient entropy.
 */
export function validateSessionSecretConfig(
  rawSecret: string | undefined = process.env.SESSION_SECRET,
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  const isProd = nodeEnv === 'production';
  const trimmed = (rawSecret ?? '').trim();

  if (isProd) {
    if (!trimmed) {
      throw new AppError(
        'FATAL: SESSION_SECRET environment variable is missing in production.',
        500,
        'INVALID_SESSION_SECRET_CONFIG'
      );
    }

    const lower = trimmed.toLowerCase();
    if (
      FORBIDDEN_PRODUCTION_SECRETS.has(lower) ||
      FORBIDDEN_PRODUCTION_SUBSTRINGS.some((sub) => lower.includes(sub))
    ) {
      throw new AppError(
        'FATAL: SESSION_SECRET in production must not use a known development or placeholder value.',
        500,
        'INSECURE_SESSION_SECRET'
      );
    }

    const byteLength = Buffer.byteLength(trimmed, 'utf8');
    if (byteLength < 32) {
      throw new AppError(
        'FATAL: SESSION_SECRET in production must be at least 32 bytes long.',
        500,
        'WEAK_SESSION_SECRET'
      );
    }

    const uniqueChars = new Set(trimmed).size;
    const entropy = computeShannonEntropyBitsPerChar(trimmed);
    if (uniqueChars < 10 || entropy < 3.0) {
      throw new AppError(
        'FATAL: SESSION_SECRET in production has insufficient cryptographic entropy.',
        500,
        'WEAK_SESSION_SECRET'
      );
    }

    return trimmed;
  }

  // Non-production (local development or automated test environment)
  if (
    !trimmed ||
    trimmed.toLowerCase() === 'replace_with_64_char_hex_session_secret_do_not_commit'
  ) {
    return LOCAL_DEV_ONLY_FALLBACK_SECRET;
  }

  return trimmed;
}

/**
 * Hashes a user password with scrypt and a cryptographic random salt.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto
    .scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash in constant time.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = parts[4];
    const expectedHex = parts[5];
    const derived = crypto.scryptSync(password, salt, KEY_LEN, { N: n, r, p });
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Generates an opaque high-entropy session token signed with HMAC-SHA256.
 * Fails fast in production if SESSION_SECRET is missing or insecure.
 */
export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const secret = validateSessionSecretConfig();
  const tokenId = crypto.randomBytes(32).toString('hex');
  const mac = crypto.createHmac('sha256', secret).update(tokenId).digest('hex');
  const rawToken = `${tokenId}.${mac}`;
  const tokenHash = sha256Hex(rawToken);
  return { rawToken, tokenHash };
}

/**
 * Verifies the HMAC signature on a raw session token before DB lookup.
 * Fails fast in production if SESSION_SECRET is missing or insecure.
 */
export function verifySessionTokenFormat(rawToken: string): boolean {
  if (!rawToken || !rawToken.includes('.')) return false;
  const [tokenId, mac] = rawToken.split('.');
  if (!tokenId || !mac || tokenId.length !== 64 || mac.length !== 64) return false;
  const secret = validateSessionSecretConfig();
  const expectedMac = crypto.createHmac('sha256', secret).update(tokenId).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expectedMac, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Derives a session-bound CSRF token from the raw session token using HMAC-SHA256.
 * Never reveals the underlying session token.
 */
export function deriveCsrfToken(rawSessionToken: string): string {
  const secret = validateSessionSecretConfig();
  return crypto
    .createHmac('sha256', secret)
    .update(`solob-csrf-v1:${rawSessionToken}`)
    .digest('hex');
}

/**
 * Verifies a candidate CSRF token against the active session token in constant time.
 */
export function verifyCsrfToken(rawSessionToken: string, candidateCsrfToken: string): boolean {
  if (!rawSessionToken || !candidateCsrfToken) return false;
  try {
    const expected = deriveCsrfToken(rawSessionToken);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.from(candidateCsrfToken.trim(), 'utf8');
    if (expectedBuf.length !== candidateBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
  } catch {
    return false;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}
