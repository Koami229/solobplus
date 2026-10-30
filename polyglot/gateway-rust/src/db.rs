//! Applies the existing SQL migrations (db/migrations/*.sql, unchanged) with the same
//! bookkeeping as the TS app: schema_migrations.version = file name. Serialized by an advisory lock.
use sqlx::PgPool;

pub const MIGRATIONS: &[(&str, &str)] = &[
    ("001_initial_schema.sql", include_str!("../../../db/migrations/001_initial_schema.sql")),
    ("002_security_hardening.sql", include_str!("../../../db/migrations/002_security_hardening.sql")),
    ("003_bootstrap_singleton.sql", include_str!("../../../db/migrations/003_bootstrap_singleton.sql")),
];

pub async fn migrate(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock(hashtext('solob_plus_migrations'))").execute(&mut *conn).await?;
    let result = async {
        let mut applied = vec![];
        for (name, sql) in MIGRATIONS {
            let exists: bool = sqlx::query_scalar(
                "SELECT to_regclass('public.schema_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)")
                .bind(name).fetch_one(&mut *conn).await
                .or_else(|_| Ok::<bool, sqlx::Error>(false))?;
            if exists { continue; }
            sqlx::raw_sql(sql).execute(&mut *conn).await?;
            sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING")
                .bind(name).execute(&mut *conn).await?;
            applied.push(name.to_string());
        }
        Ok(applied)
    }.await;
    let _ = sqlx::query("SELECT pg_advisory_unlock(hashtext('solob_plus_migrations'))").execute(&mut *conn).await;
    result
}
