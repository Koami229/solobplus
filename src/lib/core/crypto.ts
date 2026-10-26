import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, originalKeyHex] = parts;
  const derivedBuffer = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const originalBuffer = Buffer.from(originalKeyHex, 'hex');
  if (derivedBuffer.length !== originalBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedBuffer, originalBuffer);
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const rawBytes = crypto.randomBytes(32).toString('hex');
  const secret = process.env.SESSION_SECRET || 'solob-dev-ephemeral-hmac-key-not-for-prod';
  const signature = crypto.createHmac('sha256', secret).update(rawBytes).digest('hex');
  const rawToken = `${rawBytes}.${signature}`;
  const tokenHash = sha256Hex(rawToken);
  return { rawToken, tokenHash };
}

export function verifySessionTokenFormat(rawToken: string): boolean {
  const parts = rawToken.split('.');
  if (parts.length !== 2) return false;
  const [rawBytes, signature] = parts;
  const secret = process.env.SESSION_SECRET || 'solob-dev-ephemeral-hmac-key-not-for-prod';
  const expectedSig = crypto.createHmac('sha256', secret).update(rawBytes).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
