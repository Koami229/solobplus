# SOLOB+ — One Leg on School, One Leg on Business

SOLOB+ is an African AI education and managed AI project delivery platform built as a modular monolith with **Next.js 15 (App Router)**, **React 19**, **TypeScript**, and **PostgreSQL 16** (with dual support for an external PostgreSQL daemon via `pg` or zero-dependency local/embedded PostgreSQL 16 via `@electric-sql/pglite`).

---

## Core Product Architecture ("One Leg on School, One Leg on Business")

### 1. SOLOB School (Strictly Academic)
Dedicated exclusively to secondary school students (collégiens & lycéens), university students, and teachers. It never mixes academic study with job marketplace or freelance activities.
- **Academic Profile & Configurable Curricula**: Supports national and regional curricula (e.g., Bénin BAC/BEPC, WAEC WASSCE, UEMOA) with explicit `verified: boolean` coverage flags so unverified curricula or subjects are honestly labeled.
- **Private Document Upload & Text Extraction**: Students and teachers upload authorized educational documents (`.txt`, `.md`, `.csv`, `.json`, `.pdf`) stored through the private storage provider with SHA-256 integrity checks.
- **Source-Grounded AI Tutor & Fact-Checking Inspector**: Answers academic questions grounded in uploaded documents, extracts exact snippet citations, explicitly communicates epistemic uncertainty (`LOW`, `MEDIUM`, `HIGH`), and displays an unmistakable `DEMO / MOCK MODE` badge when `AI_API_KEY` is not configured.
- **Revision Material, Exercise Generation & Grading**: Generates structured revision summaries, flashcards, and rubric-based exercises, grades student answers against criterion keywords, and records persistent learning history and progress deltas.

### 2. SOLOB Business (Managed AI Talent & Project Delivery)
A managed AI operations and qualified talent delivery platform — **not** an open freelance marketplace.
- **Two Service Modes**:
  1. `MANAGED_PROJECT` (End-to-End Managed Project Delivery)
  2. `QUALIFIED_TALENT_PROVISION` (Contractual Provision of Vetted Specialists)
- **Six Core Service Categories**:
  1. `AFRICAN_LANG_TRANSCRIPTION_ANNOTATION` (Fon, Yoruba, Wolof, Hausa, etc.)
  2. `TRANSLATION_LINGUISTIC_VALIDATION`
  3. `MULTILINGUAL_DATA_PREPARATION`
  4. `AI_EVALUATION_MODEL_TESTING`
  5. `CONTENT_MODERATION_QUALITY_OPERATIONS`
  6. `CUSTOM_DIGITAL_AI_OPERATIONS`
- **Verified Language Assessment Enforcement**: Contributors cannot be treated as having verified language proficiency — and are blocked at the backend service layer (`400 UNVERIFIED_LANGUAGE_PROFICIENCY`) from being assigned to verified language tasks — unless they have passed (`passed = true`) a `LANGUAGE_PROFICIENCY` assessment for that language code.
- **Strict Task & File Isolation**: Contributors can only view and download tasks and files explicitly assigned to them (`403 FORBIDDEN_TASK_ACCESS` / `403 FORBIDDEN_FILE_ACCESS` for unassigned contributors).
- **QA Review, Authorized Delivery Reports & Compensation Ledger**: Tracks revision numbers, reviewer QA scores, client-authorized delivery reports, and compensation status (`PENDING` -> `APPROVED` -> `READY_FOR_PAYOUT` -> `PAID_SIMULATED`) with a hard guard preventing live real-money transfers until a payment provider is configured and tested.

### 3. SOLOB Core & SOLOB Labs
- **Authentication & RBAC**: `scrypt` password hashing, HMAC-SHA256 session tokens, and server-side RBAC enforcing strict separation between School (`student`, `teacher`), Business (`org_client`, `contributor`, `reviewer`, `operator`), and `admin`.
- **Audit Trail with Secret Redaction**: Records security and operational events in `audit_events` while automatically redacting `password`, `token`, `secret`, and `apiKey` fields.
- **Privacy, Retention & Linguistic Dataset Consent**: Explicit opt-in tracking for voice and linguistic dataset rights, configurable retention periods, and JSON data portability export.

---

## Quick Start

> La pile actuelle (Rust, Python, Java, C++) se trouve dans `polyglot/` (voir `DEPLOYMENT.md`).
> L'ancienne version TypeScript/Next.js 15 est archivée dans [`archive/legacy-nextjs/`](archive/legacy-nextjs/README.md), non maintenue et non déployée. Les commandes ci-dessous ne concernent que cette archive.

```bash
cd archive/legacy-nextjs
for f in db .env.example DEPLOYMENT.md SECURITY.md; do ln -s ../../$f $f; done; cp .env.example .env   # fichiers partagés restés à la racine
npm install
npm run db:migrate
npm run db:seed
npm test
npm run build && npm start
```
