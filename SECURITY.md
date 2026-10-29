# SOLOB+ Security Posture (Corrective Audit — 2026-10-29, branch `security/production-readiness`)

## Findings fixed (all verified by automated tests SEC-1…SEC-8 + core suites 1–15)

| # | Finding | Fix | Test |
|---|---------|-----|------|
| A | Public `seed_synthetic` action; demo accounts / quick-switch reachable in production | `/api/admin` `seed_synthetic` requires an authenticated `admin` and is refused (403) when `NODE_ENV=production`; `runSyntheticSeed()` and `createNonProductionInternalUser()` throw in production; `loginUser()` rejects `@synthetic.solob.local` accounts in production; quick-switch bar is shown only when the **server** reports `allowSyntheticQuickSwitch` (false in production) — no UI flag alone can enable it | SEC-1, SEC-2 |
| B | Self-registration as `admin`/`operator` | Server-side allowlist: public registration only allows `student`, `org_client`, `contributor`. `teacher`, `reviewer`, `operator`, `admin` → 403 `PRIVILEGED_ROLE_FORBIDDEN` (audited). Privileged/verified roles are created via `provisionVerifiedUser()` (admin → any; operator → teacher/reviewer) or the one-time `npm run db:bootstrap-admin` | SEC-3 |
| C | Raw session tokens in JSON + `localStorage` | Tokens only in `solob_session` cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, explicit expiry. No token in any JSON body; no `localStorage`/`sessionStorage` anywhere in `src/`. Same-origin client (`src/lib/core/client-http.ts`) uses `credentials: 'same-origin'` + `X-Solob-CSRF` header (double-submit, `solob_csrf` cookie) and Origin / `Sec-Fetch-Site` checks. Logout revokes server-side and clears cookies | 1, 15, SEC-4 |
| D | Hardcoded HMAC fallback in production | `validateSessionSecretConfig()` fails fast in production when `SESSION_SECRET` is missing, a known placeholder/dev value, < 32 bytes, or low entropy; called on DB readiness (startup path). Dev fallback only outside production | SEC-5 |
| E | Rate limiting keyed on fixed `127.0.0.1` / spoofable `X-Forwarded-For` | Forwarding headers are ignored unless `TRUST_PROXY=true` (optionally gated by `TRUSTED_PROXY_SECRET` header from the proxy); with a trusted proxy the client IP is taken `TRUSTED_PROXY_HOPS` from the right. Buckets stored in PostgreSQL (`rate_limit_buckets`, migration 002), shared across instances. Register: 15/min/client + 5/min/email; login: 15/min/client + 10/min/email | SEC-6 |
| F | Error leakage; uploads were text-only | `handleApiError()` returns generic `INTERNAL_SERVER_ERROR` for non-`AppError`s. **Additional bug found & fixed in this pass:** two separate `AppError` classes existed (`http.ts` and `rbac.ts`), so RBAC 401/403/400 errors were returned as 500 by the HTTP layer; `http.ts` now re-exports the single `rbac.ts` class. School upload accepts real `multipart/form-data` file selection; magic-byte checks (PDF `%PDF-`, ELF/PE/script rejection), MIME allowlist, size limit, owner/task authorization, private storage, and compensating delete of the stored object if the DB insert fails | 5, SEC-7, SEC-8 |

## Remaining risks / limitations
- Without `TRUST_PROXY`, per-client throttling falls back to a fingerprint (host + UA + Accept-Language), which an attacker can vary; **production must run behind a trusted reverse proxy/gateway** (or apply gateway-level rate limiting) — see DEPLOYMENT.md.
- The external `pg.Pool` code path (`DATABASE_URL`) was **not** integration-tested in this environment (no PostgreSQL server/Docker available); tests ran on embedded PostgreSQL 16 (PGlite).
- Dev-only synthetic password constant is still compiled into the client bundle for the local quick-switch; it is useless in production (synthetic logins blocked server-side), but should not be reused anywhere.
- No ESLint config: `npm run lint` is TypeScript `tsc --noEmit` only.
- No third-party penetration test, malware/AV scanning of uploads, or MFA for privileged accounts yet.
- Real payments remain disabled (`PAYMENT_PROVIDER=disabled`, live transfer → 400).
