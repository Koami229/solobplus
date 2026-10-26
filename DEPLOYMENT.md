# SOLOB+ Deployment & Rollback Guide

## 1. Environment Variables
Before deploying to staging or production, configure the environment variables defined in `.env.example`:
- `NODE_ENV=production`
- `SESSION_SECRET`: High-entropy 64-byte hex secret (`openssl rand -hex 64`).
- `DATABASE_URL`: Standard PostgreSQL 16 connection string (`postgresql://user:pass@host:5432/solob_plus?sslmode=require`). If omitted in local/edge environments, SOLOB+ uses embedded PostgreSQL (`PGLITE_DATA_DIR=./data/pgdata`).
- `STORAGE_PROVIDER=local` and `LOCAL_STORAGE_DIR=/var/lib/solob-plus/storage`.
- `AI_PROVIDER` (`mock` or `openai_compatible`), `AI_API_KEY`, `AI_MODEL`.
- `PAYMENT_PROVIDER=disabled` (keep `disabled` until live payout provider webhooks and reconciliation are verified).

---

## 2. Reproducible Deployment Steps
```bash
# 1. Install exact production dependencies
npm ci

# 2. Apply versioned PostgreSQL schema migrations
npm run db:migrate

# 3. Run automated verification suite
npm test

# 4. Build optimized Next.js production bundle
npm run build

# 5. Start production server (default port 3000)
npm start
```

---

## 3. Database Backup & Rollback Guidance
1. **Pre-Deployment Backup**:
   - External PostgreSQL: `pg_dump --format=custom --file=solob_pre_deploy_$(date +%F_%H%M).dump "$DATABASE_URL"`
   - Embedded PGlite: Archive `./data/pgdata` directory (`tar -czf pgdata_backup.tar.gz ./data/pgdata`).
2. **Migration Inspection**:
   - Applied migrations are tracked in `SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC;`.
3. **Application & Database Rollback**:
   - Redeploy the previous Git release tag (`git checkout <previous-tag> && npm ci && npm run build && npm start`).
   - If a schema change must be reverted, restore from the pre-deployment `pg_dump` snapshot into a clean target database and switch `DATABASE_URL`.
