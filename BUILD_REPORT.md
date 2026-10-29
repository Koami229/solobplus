# SOLOB+ Build Report — 2026-10-29 (branch `security/production-readiness`)

| Command | Exit code | Result |
|---------|-----------|--------|
| `npm ci` | 0 | Locked dependencies installed from `package-lock.json` |
| `npm test` | 0 | 23/23 tests passed (see TEST_REPORT.md) |
| `npm run lint` (`tsc --noEmit`) | 0 | No type errors (no ESLint configured) |
| `npm run build` (Next.js 15.5.28) | 0 | Compiled, type-checked, 11 routes generated |

Routes: `/`, `/_not-found`, `/admin`, `/business`, `/school` (static); `/api/admin`, `/api/auth`, `/api/business`, `/api/files/[fileId]`, `/api/school` (dynamic). Shared first-load JS 103 kB.

Fix required during this pass: test suite rewritten to the actual service APIs (initial draft used non-existent exports and failed typecheck with 40 errors), and duplicate `AppError` class unified (caused 500s instead of 401/403/400).

`tsconfig.tsbuildinfo` is git-ignored and untracked. External PostgreSQL build/integration: not run (no server available).
