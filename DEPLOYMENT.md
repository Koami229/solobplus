# SOLOB+ Deployment Guide (production readiness — 2026-10-29)

**Not deployed.** Nothing has been published. Real payments are disabled.

## Required production configuration
- `NODE_ENV=production`
- `SESSION_SECRET` — random, ≥ 32 bytes, high entropy, never a placeholder. Generate: `openssl rand -hex 32`. App refuses to start otherwise.
- `DATABASE_URL=postgresql://…` — managed PostgreSQL 16 (TLS), shared by all instances (also holds sessions and `rate_limit_buckets`). Run `npm run db:migrate` (applies 001 + 002).
- Reverse proxy / gateway (TLS termination, overwrites `X-Forwarded-For`): set `TRUST_PROXY=true`, `TRUSTED_PROXY_HOPS=<number of proxies>`, and preferably `TRUSTED_PROXY_SECRET` (proxy injects `x-proxy-secret`). Never set `TRUST_PROXY=true` if the app is directly reachable. Optionally add gateway-level rate limiting on `/api/auth`.
- HTTPS only (cookies are `Secure` in production).
- `LOCAL_STORAGE_DIR` on a private, non-web-served, non-executable volume (or swap the storage provider for private object storage).
- `AI_PROVIDER`/`AI_API_KEY` for live AI (otherwise explicit MOCK_DEMO mode).
- `PAYMENT_PROVIDER=disabled` until a provider is explicitly approved.
- Never run `npm run db:seed` in production (it refuses anyway).

## Initial administrator (one-time)
```
BOOTSTRAP_ADMIN_EMAIL=you@org BOOTSTRAP_ADMIN_PASSWORD='<≥12 chars, not a demo password>' \
BOOTSTRAP_ADMIN_NAME='Name' npm run db:bootstrap-admin
```
Refuses if an active admin exists, if the email is synthetic, or if the password is weak. Unset the variables afterwards. Further teacher/reviewer/operator/admin accounts are created by an authenticated admin via `/api/admin` `provision_user`.

## Steps
`npm ci && npm run db:migrate && npm run build && npm start` (behind the proxy).

## Pre-go-live checklist
Run the test suite against a disposable external PostgreSQL with `DATABASE_URL` set (not yet done), verify proxy IP forwarding, back up the DB, review logs for redaction.
