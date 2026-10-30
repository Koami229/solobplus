import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { resetDbInstanceForTests, ensureDbReady } from '@/lib/db';
import {
  checkRateLimit,
  extractTrustedClientIp,
  resetAllRateLimits,
  clearInMemoryRateLimitCacheOnly,
  enforceRateLimit,
} from '@/lib/core/rate-limit';
import {
  PROXY_SECRET_HEADER,
  validateProxyConfig,
  validateRateLimitConfig,
  validateRuntimeSecurityConfig,
  constantTimeSecretEquals,
} from '@/lib/core/config';
import { bootstrapInitialAdmin, loginUser, registerUser } from '@/lib/core/auth';
import { handleApiError } from '@/lib/core/http';
import { POST as authPost } from '@/app/api/auth/route';
import fs from 'fs';
import path from 'path';

const PROXY_SECRET = 'pX9#kL2@vQ7!mN4$tR8&wZ1^bY6*cF3%hJ5';
const STRONG_SECRET = 'Zq8#xV2!mK9pL4@tR7wN1$bY6&cF3^hJ5*gD0Q';

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const req = (headers: Record<string, string>) => new Request('http://app.local/api/auth', { headers });

describe('SOLOB+ Staging Final Hardening', () => {
  beforeEach(async () => {
    await resetDbInstanceForTests('memory://');
    await resetAllRateLimits();
  });

  // ---------------------------------------------------------------- Proxy trust
  describe('Reverse proxy trust (x-solob-proxy-secret)', () => {
    it('PRX-1 startup validation: production TRUST_PROXY=true without secret / weak secret / bad hops is rejected', async () => {
      const base = { NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET };
      expect(() => validateProxyConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUSTED_PROXY_SECRET/);
      expect(() => validateProxyConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: '   ' })).toThrow(/TRUSTED_PROXY_SECRET/);
      expect(() => validateProxyConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: 'short' })).toThrow(/32/);
      expect(() =>
        validateProxyConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: 'REPLACE_WITH_LONG_RANDOM_PROXY_SECRET_VALUE' })
      ).toThrow();
      expect(() => validateProxyConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
      for (const hops of ['0', '-1', 'abc', '1.5', '11']) {
        expect(() => validateProxyConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: PROXY_SECRET, TRUSTED_PROXY_HOPS: hops })).toThrow(/HOPS/);
      }
      expect(validateProxyConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: PROXY_SECRET, TRUSTED_PROXY_HOPS: '2' })).toEqual({
        trustProxy: true,
        hops: 2,
        secret: PROXY_SECRET,
      });
      expect(validateProxyConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
      // Full startup check (used by instrumentation.ts and ensureDbReady)
      expect(() => validateRuntimeSecurityConfig({ ...base, TRUST_PROXY: 'true' })).toThrow();
      await withEnv({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: undefined }, async () => {
        await expect(resetDbInstanceForTests('memory://')).rejects.toThrow(/TRUSTED_PROXY_SECRET/);
      });
    });

    it('PRX-2 constant-time comparison helper', () => {
      expect(constantTimeSecretEquals(PROXY_SECRET, PROXY_SECRET)).toBe(true);
      expect(constantTimeSecretEquals(PROXY_SECRET + 'x', PROXY_SECRET)).toBe(false);
      expect(constantTimeSecretEquals('', PROXY_SECRET)).toBe(false);
      expect(constantTimeSecretEquals(null, PROXY_SECRET)).toBe(false);
      expect(constantTimeSecretEquals(PROXY_SECRET, '')).toBe(false);
      const src = fs.readFileSync(path.resolve('src/lib/core/config.ts'), 'utf8');
      expect(src).toContain('timingSafeEqual');
    });

    it('PRX-3 missing / incorrect / correct secret, spoofed headers, multiple hops', async () => {
      const env = { NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: PROXY_SECRET, TRUSTED_PROXY_HOPS: '1' };
      await withEnv(env, () => {
        // missing header -> forwarding headers ignored
        const missing = extractTrustedClientIp(req({ 'x-forwarded-for': '6.6.6.6' }));
        expect(missing.startsWith('direct-client:')).toBe(true);
        // incorrect secret -> ignored
        const wrong = extractTrustedClientIp(req({ 'x-forwarded-for': '6.6.6.6', [PROXY_SECRET_HEADER]: 'nope' }));
        expect(wrong.startsWith('direct-client:')).toBe(true);
        expect(wrong).not.toContain('6.6.6.6');
        // legacy header name is NOT accepted
        const legacy = extractTrustedClientIp(req({ 'x-forwarded-for': '6.6.6.6', 'x-proxy-secret': PROXY_SECRET }));
        expect(legacy.startsWith('direct-client:')).toBe(true);
        // correct secret -> rightmost hop
        expect(extractTrustedClientIp(req({ 'x-forwarded-for': '41.202.219.55', [PROXY_SECRET_HEADER]: PROXY_SECRET }))).toBe('proxy-ip:41.202.219.55');
        // spoofed left entries ignored
        expect(
          extractTrustedClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 41.202.219.55', [PROXY_SECRET_HEADER]: PROXY_SECRET }))
        ).toBe('proxy-ip:41.202.219.55');
        // spoofed x-real-ip without auth ignored
        expect(extractTrustedClientIp(req({ 'x-real-ip': '7.7.7.7' })).startsWith('direct-client:')).toBe(true);
      });
      await withEnv({ ...env, TRUSTED_PROXY_HOPS: '2' }, () => {
        // client -> CDN (appends client) -> nginx (appends CDN) -> app
        expect(
          extractTrustedClientIp(req({ 'x-forwarded-for': '9.9.9.9, 41.202.219.55, 10.0.0.2', [PROXY_SECRET_HEADER]: PROXY_SECRET }))
        ).toBe('proxy-ip:41.202.219.55');
        // fewer entries than hops -> not trusted
        expect(
          extractTrustedClientIp(req({ 'x-forwarded-for': '10.0.0.2', [PROXY_SECRET_HEADER]: PROXY_SECRET })).startsWith('direct-client:')
        ).toBe(true);
      });
      await withEnv({ ...env, TRUSTED_PROXY_HOPS: '3' }, () => {
        expect(
          extractTrustedClientIp(req({ 'x-forwarded-for': '41.202.219.55, 10.0.0.3, 10.0.0.2', [PROXY_SECRET_HEADER]: PROXY_SECRET }))
        ).toBe('proxy-ip:41.202.219.55');
      });
    });

    it('PRX-4 REAL socket integration: Node reverse proxy strips client header, injects secret, appends XFF in front of a real HTTP server running the auth route', async () => {
      const toRequest = async (m: http.IncomingMessage): Promise<Request> => {
        const chunks: Buffer[] = [];
        for await (const c of m) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(m.headers)) {
          if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        return new Request(`http://${m.headers.host}${m.url}`, {
          method: m.method,
          headers,
          body: m.method === 'GET' || m.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
      };

      // Application server (real socket) — exposes the resolved bucket and the real auth route
      const app = http.createServer(async (m, r) => {
        const request = await toRequest(m);
        let res: Response;
        if (m.url === '/whoami') {
          res = Response.json({ ip: extractTrustedClientIp(request) });
        } else if (m.url === '/limited') {
          try {
            await enforceRateLimit(`it:proxy:${extractTrustedClientIp(request)}`, 3, 60_000);
            res = Response.json({ ok: true });
          } catch (e) {
            res = handleApiError(e);
          }
        } else {
          res = await authPost(request);
        }
        r.writeHead(res.status, { 'content-type': 'application/json' });
        r.end(Buffer.from(await res.arrayBuffer()));
      });
      await new Promise<void>((ok) => app.listen(0, '127.0.0.1', ok));
      const appPort = (app.address() as AddressInfo).port;

      // Reverse proxy (real socket): strips client copy of the header, injects its own, appends peer IP to XFF
      const proxy = http.createServer((cm, cr) => {
        const headers = { ...cm.headers };
        delete headers[PROXY_SECRET_HEADER];
        headers[PROXY_SECRET_HEADER] = PROXY_SECRET;
        const peer = cm.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
        headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
        const up = http.request({ host: '127.0.0.1', port: appPort, path: cm.url, method: cm.method, headers }, (ur) => {
          cr.writeHead(ur.statusCode || 502, ur.headers);
          ur.pipe(cr);
        });
        cm.pipe(up);
      });
      await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
      const proxyPort = (proxy.address() as AddressInfo).port;

      const env = { NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET, TRUST_PROXY: 'true', TRUSTED_PROXY_SECRET: PROXY_SECRET, TRUSTED_PROXY_HOPS: '1' };
      try {
        await withEnv(env, async () => {
          const spoof = { 'x-forwarded-for': '6.6.6.6', [PROXY_SECRET_HEADER]: 'attacker-guess' };
          // via proxy: spoofed XFF and secret are neutralised; client IP = real socket peer
          const viaProxy = await (await fetch(`http://127.0.0.1:${proxyPort}/whoami`, { headers: spoof })).json();
          expect(viaProxy.ip).toBe('proxy-ip:127.0.0.1');
          // direct to app bypassing proxy: forwarding headers not trusted
          const direct = await (await fetch(`http://127.0.0.1:${appPort}/whoami`, { headers: spoof })).json();
          expect(direct.ip.startsWith('direct-client:')).toBe(true);
          expect(direct.ip).not.toContain('6.6.6.6');

          // Rate limit over real sockets: rotating spoofed XFF does not create new buckets
          const statuses: number[] = [];
          for (let i = 0; i < 5; i++) {
            const r = await fetch(`http://127.0.0.1:${proxyPort}/limited`, { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
            statuses.push(r.status);
          }
          expect(statuses).toEqual([200, 200, 200, 429, 429]);

          // Real auth route through proxy: login throttling (15/min per client), unique emails each time
          const loginStatuses: number[] = [];
          for (let i = 0; i < 16; i++) {
            const r = await fetch(`http://127.0.0.1:${proxyPort}/api/auth`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` },
              body: JSON.stringify({ action: 'login', email: `nobody${i}@example.org`, password: 'WrongPassword!2026' }),
            });
            loginStatuses.push(r.status);
          }
          expect(loginStatuses.slice(0, 15).every((s) => s !== 429)).toBe(true);
          expect(loginStatuses[15]).toBe(429);
        });
      } finally {
        await new Promise((ok) => proxy.close(ok));
        await new Promise((ok) => app.close(ok));
      }
    });
  });

  // ---------------------------------------------------------------- Atomic rate limiting
  describe('Atomic distributed rate limiting', () => {
    it('RL-1 50 concurrent requests admit exactly max (atomic INSERT ... ON CONFLICT ... RETURNING)', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => checkRateLimit({ key: 'conc:1', maxRequests: 7, windowMs: 60_000 }))
      );
      expect(results.filter((r) => r.allowed).length).toBe(7);
      expect(results.filter((r) => !r.allowed).every((r) => r.retryAfterMs > 0)).toBe(true);
      const db = await ensureDbReady();
      const row = (await db.query<{ hit_count: number }>(`SELECT hit_count FROM rate_limit_buckets WHERE bucket_key = 'conc:1'`)).rows[0];
      expect(Number(row.hit_count)).toBe(8); // capped at max+1, no unbounded growth
      const src = fs.readFileSync(path.resolve('src/lib/core/rate-limit.ts'), 'utf8');
      expect(src).toMatch(/ON CONFLICT \(bucket_key\) DO UPDATE/);
      expect(src).not.toMatch(/SELECT bucket_key, hit_count/);
    });

    it('RL-2 window expiry resets atomically; buckets survive local cache loss', async () => {
      expect((await checkRateLimit({ key: 'win', maxRequests: 1, windowMs: 200 })).allowed).toBe(true);
      clearInMemoryRateLimitCacheOnly();
      expect((await checkRateLimit({ key: 'win', maxRequests: 1, windowMs: 200 })).allowed).toBe(false);
      await new Promise((r) => setTimeout(r, 260));
      expect((await checkRateLimit({ key: 'win', maxRequests: 1, windowMs: 200 })).allowed).toBe(true);
    });

    it('RL-3 concurrent registration and login are throttled', async () => {
      const ip = 'proxy-ip:41.202.219.77';
      const regs = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          registerUser(
            { email: `c${i}@example.org`, password: 'StrongPassword!2026', fullName: 'Ama Test', role: 'student', preferredUiLang: 'fr', countryCode: 'BJ' },
            ip
          )
        )
      );
      const limited = regs.filter((r) => r.status === 'rejected' && (r.reason as any).code === 'RATE_LIMITED').length;
      expect(regs.filter((r) => r.status === 'fulfilled').length).toBe(15);
      expect(limited).toBe(5);
      const logins = await Promise.allSettled(
        Array.from({ length: 12 }, () => loginUser({ email: 'c0@example.org', password: 'bad-password-xx' }, 'proxy-ip:41.202.219.78'))
      );
      expect(logins.filter((r) => r.status === 'rejected' && (r.reason as any).code === 'RATE_LIMITED').length).toBe(2);
    });

    const breakDb = () => {
      const g = global as any;
      const saved = { a: g.__solobDbAdapter, m: g.__solobDbMigrated };
      g.__solobDbAdapter = {
        engineType: 'pg-pool',
        query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'); },
        exec: async () => { throw new Error('connect ECONNREFUSED'); },
        close: async () => undefined,
        transaction: async () => { throw new Error('connect ECONNREFUSED'); },
      };
      g.__solobDbMigrated = true;
      return () => { g.__solobDbAdapter = saved.a; g.__solobDbMigrated = saved.m; };
    };

    it('RL-4 PostgreSQL unavailable in production: fail closed with 503 RATE_LIMIT_UNAVAILABLE, no memory fallback, no detail leak', async () => {
      const restore = breakDb();
      try {
        await withEnv({ NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET }, async () => {
          await expect(checkRateLimit({ key: 'down', maxRequests: 5, windowMs: 60_000 })).rejects.toMatchObject({ statusCode: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
          const res = await authPost(new Request('http://app.local/api/auth', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'login', email: 'x@example.org', password: 'whatever-123' }),
          }));
          expect(res.status).toBe(503);
          const body = await res.text();
          expect(body).toContain('RATE_LIMIT_UNAVAILABLE');
          expect(body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|password=secret/);
        });
        expect(() => validateRateLimitConfig({ NODE_ENV: 'production', RATE_LIMIT_ALLOW_MEMORY_FALLBACK: 'true' })).toThrow(/forbidden in production/);
      } finally {
        restore();
      }
    });

    it('RL-5 PostgreSQL unavailable in development/test: explicit in-memory fallback; can be disabled', async () => {
      const restore = breakDb();
      try {
        await withEnv({ NODE_ENV: 'test', RATE_LIMIT_ALLOW_MEMORY_FALLBACK: undefined }, async () => {
          const r = await Promise.all(Array.from({ length: 4 }, () => checkRateLimit({ key: 'dev-down', maxRequests: 2, windowMs: 60_000 })));
          expect(r.filter((x) => x.allowed).length).toBe(2);
        });
        await withEnv({ NODE_ENV: 'development', RATE_LIMIT_ALLOW_MEMORY_FALLBACK: 'false' }, async () => {
          await expect(checkRateLimit({ key: 'dev-down2', maxRequests: 2, windowMs: 60_000 })).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
        });
      } finally {
        restore();
      }
    });
  });

  // ---------------------------------------------------------------- Bootstrap
  describe('Initial administrator bootstrap', () => {
    const input = { email: 'root.admin@solob.example', password: 'Ultra#Secure-Bootstrap-2026!', fullName: 'Initial Admin', countryCode: 'BJ' };

    it('BOOT-1 concurrent bootstrap invocations create exactly one admin; re-run refuses; password never stored in audit', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => bootstrapInitialAdmin({ ...input, email: `root${i}@solob.example` }))
      );
      expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.code).toBe('ADMIN_ALREADY_BOOTSTRAPPED');
      }
      const db = await ensureDbReady();
      expect((await db.query(`SELECT id FROM users WHERE role = 'admin'`)).rows.length).toBe(1);
      expect((await db.query(`SELECT * FROM system_bootstrap`)).rows.length).toBe(1);
      await expect(bootstrapInitialAdmin({ ...input, email: 'second@solob.example' })).rejects.toMatchObject({ code: 'ADMIN_ALREADY_BOOTSTRAPPED' });
      const audit = await db.query<{ redacted_metadata_json: unknown }>(`SELECT redacted_metadata_json FROM audit_events WHERE action = 'ADMIN_BOOTSTRAP_INITIAL'`);
      expect(audit.rows.length).toBe(1);
      expect(JSON.stringify(audit.rows)).not.toContain('Ultra#Secure-Bootstrap-2026!');
      expect(JSON.stringify(audit.rows)).not.toMatch(/password|scrypt/i);
    });

    it('BOOT-2 database invariant: a second system_bootstrap row is impossible', async () => {
      const admin = await bootstrapInitialAdmin(input);
      const db = await ensureDbReady();
      await expect(db.query(`INSERT INTO system_bootstrap (bootstrap_key, admin_user_id) VALUES ('initial_admin', $1)`, [admin.id])).rejects.toThrow();
      await expect(db.query(`INSERT INTO system_bootstrap (bootstrap_key, admin_user_id) VALUES ('another', $1)`, [admin.id])).rejects.toThrow();
    });

    it('BOOT-3 CLI script, .env.example and DEPLOYMENT.md use the same BOOTSTRAP_ADMIN_* names and the script never logs the password', () => {
      const script = fs.readFileSync(path.resolve('scripts/bootstrap-admin.ts'), 'utf8');
      const envEx = fs.readFileSync(path.resolve('.env.example'), 'utf8');
      const dep = fs.readFileSync(path.resolve('DEPLOYMENT.md'), 'utf8');
      for (const name of ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD', 'BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_COUNTRY']) {
        expect(script).toContain(name);
        expect(envEx).toContain(name);
        expect(dep).toContain(name);
      }
      for (const txt of [script, envEx, dep]) expect(txt).not.toContain('INITIAL_ADMIN_');
      expect(script).not.toMatch(/console\.\w+\([^)]*password/i);
      for (const txt of [envEx, dep, fs.readFileSync(path.resolve('SECURITY.md'), 'utf8')]) {
        expect(txt).toContain('x-solob-proxy-secret');
        expect(txt).not.toMatch(/x-proxy-secret/);
      }
    });

    it('BOOT-4 bootstrap CLI end-to-end in a child process: succeeds once, refuses twice, never prints the password', async () => {
      const { spawnSync } = await import('child_process');
      const dir = fs.mkdtempSync('/tmp/solob-boot-');
      const env = {
        ...process.env,
        SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET: '',
        NODE_ENV: 'production',
        SESSION_SECRET: STRONG_SECRET,
        PGLITE_DATA_DIR: dir,
        DATABASE_URL: '',
        TRUST_PROXY: 'false',
        BOOTSTRAP_ADMIN_EMAIL: 'cli.admin@solob.example',
        BOOTSTRAP_ADMIN_PASSWORD: 'Cli#Bootstrap-Secret-2026!',
        BOOTSTRAP_ADMIN_NAME: 'CLI Admin',
        BOOTSTRAP_ADMIN_COUNTRY: 'BJ',
      } as NodeJS.ProcessEnv;
      const run = () => spawnSync('npx', ['tsx', 'scripts/bootstrap-admin.ts'], { env, encoding: 'utf8', timeout: 60_000 });
      const first = run();
      const second = run();
      fs.rmSync(dir, { recursive: true, force: true });
      expect(first.status).toBe(0);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('already exists');
      for (const out of [first.stdout, first.stderr, second.stdout, second.stderr]) {
        expect(out).not.toContain('Cli#Bootstrap-Secret-2026!');
      }
    }, 120_000);
  });
});
