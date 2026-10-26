# SOLOB+ Technical Architecture

## 1. Architectural Pattern: Modular Monolith
SOLOB+ is organized as a modular monolith in `/workspace/solob-plus` with strict separation between:
- **Presentation Layer (`src/app/`, `src/components/`)**: Next.js 15 App Router pages and responsive React client workspaces (`SchoolView`, `BusinessView`, `AdminCoreView`, `SolobAppShell`).
- **HTTP Transport Layer (`src/app/api/*`)**: Route handlers (`/api/auth`, `/api/school`, `/api/business`, `/api/files/[fileId]`, `/api/admin`) performing request parsing, session extraction, and standardized error serialization (`src/lib/core/http.ts`).
- **Domain & Service Layer (`src/lib/core/*`, `src/lib/school/*`, `src/lib/business/*`, `src/lib/ai/*`)**: Pure TypeScript business rules, server-side RBAC enforcement, explainable talent matching, epistemic grounding, and storage authorization.
- **Relational Persistence Layer (`src/lib/db/index.ts`, `db/schema.sql`, `db/migrations/001_initial_schema.sql`)**: Full PostgreSQL 16 relational schema (30 tables with foreign keys, `CHECK` constraints, and composite indexes).

---

## 2. Dual-Mode PostgreSQL Relational Adapter (`src/lib/db/index.ts`)
During initial environment inspection of the host machine, no external `postgres` daemon was installed. To ensure **100% real PostgreSQL 16 SQL execution** (including `JSONB`, `TIMESTAMPTZ`, foreign keys, `CHECK` constraints, and transactional integrity) without requiring external credentials:
1. **External PostgreSQL Mode (`pg.Pool`)**: Automatically used whenever `DATABASE_URL` starts with `postgres://` or `postgresql://`.
2. **Embedded PostgreSQL 16 Mode (`@electric-sql/pglite`)**: Automatically used when `DATABASE_URL` is unset (persisting to `./data/pgdata`) or set to `memory://` during isolated Vitest test runs.

Both modes execute the exact same `db/migrations/001_initial_schema.sql` file and record applied migrations in `schema_migrations`.

---

## 3. Database Schema Overview (30 Tables)
- **SOLOB Core**: `users`, `user_sessions`, `roles_permissions`, `audit_events`, `notifications`, `stored_files`, `feature_flags`, `languages_registry`, `ai_usage_records`, `privacy_requests`, `schema_migrations`.
- **SOLOB School**: `academic_curricula`, `academic_levels`, `academic_subjects`, `academic_profiles`, `school_documents`, `ai_explanations`, `revision_materials`, `school_exercises`, `exercise_submissions`, `learning_activities`.
- **SOLOB Business**: `organizations`, `business_projects`, `talent_profiles`, `talent_assessments`, `project_team_allocations`, `business_tasks`, `task_submissions`, `quality_reviews`, `delivery_reports`, `compensation_records`.

---

## 4. Security & Boundary Guarantees
- **Pillar Isolation**: `enforceRole()` in `src/lib/core/rbac.ts` verifies both the user's authenticated session and their allowed role list, logging any `RBAC_DENIED_ROLE` event to `audit_events`.
- **Task & File Isolation**: `readAuthorizedFile()` in `src/lib/core/storage.ts` checks `stored_files.owner_user_id` and `business_tasks.assigned_contributor_id` / `assigned_reviewer_id` before returning any bytes.
- **AI Provider Abstraction**: `executeGroundedAI()` in `src/lib/ai/provider.ts` handles rate limiting, timeout/retry logic, token & cost estimation, source citation extraction, and explicit `MOCK_DEMO` vs `LIVE` labeling.
