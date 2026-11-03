# Changelog

## [Unreleased] — branch `mcdl/critical-hardening`
### Added
- HTTP security headers (CSP, HSTS prod-only, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP) — `src/lib/core/security-headers.ts`, `next.config.ts`.
- Tests `tests/security-headers.test.ts`.
- GitHub Actions CI `.github/workflows/ci.yml` (PGlite + PostgreSQL 16 jobs) — MCDL regression testing (support p.62).
### Changed
- `poweredByHeader: false`.
No feature, schema or migration changed.
