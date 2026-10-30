# SOLOB+ Deployment Guide (staging final hardening — 2026-10-30, branch `security/staging-final-hardening`)

**Not deployed.** Nothing has been published. Real payments are disabled.

## Required production configuration
- `NODE_ENV=production`
- `SESSION_SECRET` — random, ≥ 32 bytes, high entropy, never a placeholder. Generate: `openssl rand -hex 32`. App refuses to start otherwise.
- `DATABASE_URL=postgresql://…` — managed PostgreSQL 16 (TLS), shared by all instances (also holds sessions and `rate_limit_buckets`). Run `npm run db:migrate` (applies 001 + 002 + 003).
- Reverse proxy / gateway (TLS termination): set `TRUST_PROXY=true`, `TRUSTED_PROXY_HOPS=<number of trusted proxies that append to X-Forwarded-For>` (positive integer 1–10) and **`TRUSTED_PROXY_SECRET`** (≥ 32 high-entropy chars, `openssl rand -hex 32`). In production, `TRUST_PROXY=true` without a valid secret, an invalid `TRUST_PROXY` value, or invalid hops **aborts startup** (`src/instrumentation.ts` + every DB readiness check). The proxy authenticates itself with the canonical header **`x-solob-proxy-secret`**. Never set `TRUST_PROXY=true` if the app port is reachable without the proxy (firewall the app port to the proxy only).
- `RATE_LIMIT_ALLOW_MEMORY_FALLBACK` must be unset or `false` in production (`true` aborts startup). If PostgreSQL is unreachable, rate-limited endpoints (login, registration, APIs) fail closed with `503 RATE_LIMIT_UNAVAILABLE`.
- HTTPS only (cookies are `Secure` in production).
- `LOCAL_STORAGE_DIR` on a private, non-web-served, non-executable volume (or swap the storage provider for private object storage).
- `AI_PROVIDER`/`AI_API_KEY` for live AI (otherwise explicit MOCK_DEMO mode).
- `PAYMENT_PROVIDER=disabled` until a provider is explicitly approved.
- Never run `npm run db:seed` in production (it refuses anyway).

## Initial administrator (one-time)
```
BOOTSTRAP_ADMIN_EMAIL=you@org BOOTSTRAP_ADMIN_PASSWORD='<≥12 chars, not a demo password>' \
BOOTSTRAP_ADMIN_NAME='Name' BOOTSTRAP_ADMIN_COUNTRY=BJ npm run db:bootstrap-admin
```
Variables (identical in `.env.example`, this guide and `scripts/bootstrap-admin.ts`): `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_COUNTRY` (ISO alpha-2, default `BJ`). Prefer passing the password from a secret manager rather than shell history. The script never prints the password.
Concurrency-safe: runs in one transaction holding `pg_advisory_xact_lock`, and the `system_bootstrap` singleton row (migration 003, PRIMARY KEY + CHECK) guarantees at most one initial admin even if several invocations race. Refuses (exit 1, `ADMIN_ALREADY_BOOTSTRAPPED`) if an active admin or bootstrap marker exists, if the email is synthetic, or if the password is weak. Unset the variables afterwards. Further teacher/reviewer/operator/admin accounts are created by an authenticated admin via `/api/admin` `provision_user`.

## Reverse proxy requirements
The proxy MUST (1) **strip any client-supplied `x-solob-proxy-secret` header**, (2) inject its own `x-solob-proxy-secret: <TRUSTED_PROXY_SECRET>`, and (3) append (not pass through blindly) the peer address to `X-Forwarded-For`. The app compares the secret in constant time (SHA-256 digests + `crypto.timingSafeEqual`); if it is missing or wrong, **all forwarding headers are ignored**. The client IP is the `TRUSTED_PROXY_HOPS`-th entry from the right of `X-Forwarded-For`.

nginx:
```nginx
location / {
    proxy_set_header x-solob-proxy-secret "<TRUSTED_PROXY_SECRET>";   # overrides any client copy
    proxy_set_header X-Forwarded-For $remote_addr;                  # single hop: replace, don't trust client XFF
    proxy_set_header X-Real-IP "";
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:3000;
}
```
(Behind a CDN plus nginx use `$proxy_add_x_forwarded_for`, configure `real_ip`, and set `TRUSTED_PROXY_HOPS=2`.)

Caddy:
```caddy
solob.example.org {
    reverse_proxy 127.0.0.1:3000 {
        header_up -x-solob-proxy-secret
        header_up x-solob-proxy-secret {env.TRUSTED_PROXY_SECRET}
        header_up X-Forwarded-For {remote_host}
    }
}
```

## Steps
`npm ci && npm run db:migrate && npm run build && npm start` (behind the proxy).

## Pre-go-live checklist
- Run the suite against the **staging** managed PostgreSQL 16 (disposable database only — it drops the `public` schema): `SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET=1 DATABASE_URL=postgresql://… npm test`. This was done locally against a real PostgreSQL 16.14 server (see TEST_REPORT.md); repeat on the staging provider (TLS, pooler).
- Verify with the real nginx/Caddy config that a request carrying a forged `x-solob-proxy-secret` and `X-Forwarded-For` is bucketed by the proxy-observed IP.
- Back up the DB; review logs for redaction.
