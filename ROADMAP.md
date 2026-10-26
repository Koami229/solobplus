# SOLOB+ Product & Engineering Roadmap

## Phase 1–7 (Completed in Current Autonomous Build)
- [x] **Phase 1: Application Foundation**: Next.js 15 App Router modular monolith, PostgreSQL 16 schema (30 tables), dual-mode database adapter (`pg` + `@electric-sql/pglite`), migration & synthetic seed runners.
- [x] **Phase 2: SOLOB Core**: `scrypt` authentication, HMAC sessions, server-side RBAC, private file storage abstraction, redacted audit trail, notifications, African language registry (`fra`, `eng`, `fon`, `yor`, `wol`, `hau`), feature flags, and privacy/consent center.
- [x] **Phase 3: SOLOB School Vertical Slice**: Learner/teacher profiles, curriculum verification badges, document upload & extraction, source-grounded AI tutor with epistemic uncertainty, revision material & exercise generation, rubric-based grading, and learning progress tracking.
- [x] **Phase 4: SOLOB Business Vertical Slice**: `MANAGED_PROJECT` & `QUALIFIED_TALENT_PROVISION` workflows, talent profiles with dataset consent, verified language assessment enforcement (`passed = true`), explainable talent matching, strict task/file isolation, revision & QA review workflows, authorized delivery reports, and simulated compensation ledger.
- [x] **Phase 5: AI & Multilingual Services**: Server-side AI provider abstraction with retries, timeouts, rate limiting, token/cost logging, and explicit `MOCK_DEMO` vs `LIVE` mode.
- [x] **Phase 6: Operational Maturity**: Sliding-window rate limiting, data export portability, linguistic consent tracking, and operator governance dashboard.
- [x] **Phase 7: Verification & Release Readiness**: All 15 mandatory automated test suites passing (`15/15`) and clean production build (`npm run build`).

---

## Upcoming Milestones (Post-V1)
1. **Live External AI Provider Credentials & Multimodal OCR/ASR**:
   - Connect production `AI_API_KEY` for live LLM inference and Whisper/MMS speech-to-text models for African-language audio transcription tasks.
2. **S3-Compatible Object Storage Adapter**:
   - Extend `StorageProvider` interface in `src/lib/core/storage.ts` with pre-signed S3/R2 bucket uploads for large audio/video datasets.
3. **Ministry & Exam Board Curriculum Verification Expansion**:
   - Complete official syllabus verification for `SN-BAC-UEMOA` and additional francophone/anglophone West & Central African exam tracks.
4. **Verified Assessor Cohorts for Wolof & Hausa**:
   - Onboard certified linguistic assessors to transition `wol` and `hau` in `languages_registry` from `business_verified = false` to `true`.
5. **Sandbox-to-Live Mobile Money & Bank Payout Integration**:
   - Integrate FedaPay / Flutterwave / Stripe Connect behind `PAYMENT_PROVIDER` with dual-operator approval before enabling live payouts.
