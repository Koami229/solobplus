# SOLOB+ Security Policy & Controls

## 1. Secret Management
- **Zero Committed Secrets**: `.env`, `.env.local`, and runtime storage directories (`./data/`) are excluded via `.gitignore`.
- **Placeholder Template**: `.env.example` contains only safe placeholder values.
- **Audit Log Redaction**: `redactSensitiveMetadata()` in `src/lib/core/audit.ts` recursively inspects all audit metadata objects and replaces any key matching `password`, `token`, `secret`, `authorization`, `cookie`, `api_key`, `apikey`, `private_key`, or `credential` with `"[REDACTED]"` before database insertion.

## 2. Authentication & Session Security
- **Password Hashing**: Passwords are hashed using Node's native `crypto.scryptSync` (`N=16384, r=8, p=1`, 64-byte key length) with a unique 16-byte cryptographic salt per user and verified using `crypto.timingSafeEqual`.
- **Session Tokens**: Session tokens are signed with HMAC-SHA256 (`SESSION_SECRET`) and stored in the `user_sessions` table as SHA-256 hashes (`token_hash`) with explicit expiration (`expires_at`) and revocation (`revoked_at`) timestamps, plus `HttpOnly` cookie attributes.

## 3. Server-Side Role-Based Access Control (RBAC)
Every mutating and sensitive read operation enforces role permissions on the server:
- **School Roles**: `student`, `teacher`
- **Business Roles**: `org_client`, `contributor`, `reviewer`, `operator`
- **Platform Governance**: `admin`
Cross-pillar access (e.g., a `student` attempting to create a Business project, or an `org_client` attempting to upload a School document) is rejected with `403 FORBIDDEN_ROLE` and recorded in `audit_events`.

## 4. File Upload Validation & Private Object Storage
- **Allowlisted MIME Types**: Only `text/plain`, `text/markdown`, `text/csv`, `application/json`, and `application/pdf` are accepted.
- **Forbidden Extensions**: Executable and script extensions (`.exe`, `.sh`, `.bat`, `.cmd`, `.js`, `.php`, `.py`, `.dll`, `.so`, `.jar`) are rejected (`400 FORBIDDEN_FILE_TYPE`).
- **Size Limits**: Enforced via `MAX_UPLOAD_BYTES` (default 10 MB; rejects oversized payloads with `413 FILE_TOO_LARGE`).
- **Per-User & Per-Task Authorization**: Private School files are accessible only to their owner (or `admin`). Business task files (`visibility = 'assigned_task'`) are accessible only to the `assigned_contributor_id`, `assigned_reviewer_id`, project `client_user_id`, or `operator`/`admin`.

## 5. Payment & Real-Money Transfer Protection
- `updateCompensationStatus()` in `src/lib/business/service.ts` blocks any attempt to trigger a live payout (`400 LIVE_TRANSFER_DISABLED`) unless `PAYMENT_PROVIDER` is explicitly configured and verified. All compensation state transitions (`PENDING` -> `APPROVED` -> `READY_FOR_PAYOUT` -> `PAID_SIMULATED`) are recorded in `audit_events`.
