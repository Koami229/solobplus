# SOLOB+ — Test Report (Staging Final Hardening, 2026-10-30)

## Commands and exit codes
| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | clean install |
| `npm test` (embedded PGlite) | 0 | 3 files: 2 passed, 1 skipped; **36 passed, 4 skipped (40)** |
| `SOLOB_TEST_ALLOW_DESTRUCTIVE_DB_RESET=1 DATABASE_URL=postgresql://…@127.0.0.1:55432/solob_test npm test` | 0 | 3 files passed; **40 passed (40)** |
| `npm run lint` (`tsc --noEmit`) | 0 | no errors |
| `npm run build` | 0 | compiled successfully |

The 4 skipped tests in the default run are `tests/external-postgres.test.ts` (EXT-1..4). They skip unless DATABASE_URL and the destructive-reset flag are set.

## External PostgreSQL: actually executed
- Server: a real **PostgreSQL 16.14** server (official binaries from `@embedded-postgres/linux-x64@16.14.0-beta.17`), running locally over TCP with SCRAM auth on a disposable database.
- Engine: `pg.Pool` via DATABASE_URL. EXT-1 asserts the pg-pool adapter and server version 16.x.
- The whole suite ran against it: the existing 23 tests, 13 hardening tests and 4 EXT tests.
- Not done: no run on the managed staging provider. Repeat on the real staging DB before go-live.

## Proxy tests
- PRX-1..3 are unit tests: missing, wrong and correct secret; spoofed XFF/X-Real-IP/CF headers; multiple hops; a short chain.
- PRX-4 is a real-socket integration test. A Node `http` reverse proxy strips the client's `x-solob-proxy-secret`, injects its own and appends XFF, in front of a real HTTP server running the production `extractTrustedClientIp`, `enforceRateLimit` and login throttling.
- It is not nginx or Caddy. Those configs are documented in DEPLOYMENT.md but were not executed.

## Suites
- `tests/solob-plus.test.ts`: the 23 existing protection/journey tests, all passing.
- `tests/staging-hardening.test.ts`, 13 tests:
  - PRX-1..4 (proxy trust).
  - RL-1..5: 50 concurrent requests → exactly `max` admitted; counter capped; window reset; register/login concurrency; production DB down → 503 `RATE_LIMIT_UNAVAILABLE` without leaking details; memory fallback only in dev/test.
  - BOOT-1..4: 8 concurrent bootstraps → 1 admin; singleton DB invariant; env names consistent across script, `.env.example` and DEPLOYMENT.md; the CLI succeeds once, fails the second time and never prints the password.
- `tests/external-postgres.test.ts`, EXT-1..4: engine/version; migrations 001–003; 100 concurrent requests → exactly 13 allowed; 10 concurrent bootstraps on separate connections → 1 admin; register/login/logout round-trip.
