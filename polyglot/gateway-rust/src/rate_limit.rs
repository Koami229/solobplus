//! Atomic PostgreSQL fixed-window rate limiter — identical SQL to src/lib/core/rate-limit.ts.
use crate::error::AppError;
use sqlx::PgPool;

pub const ATOMIC_RATE_LIMIT_SQL: &str = r#"
INSERT INTO rate_limit_buckets AS b (bucket_key, hit_count, window_start, window_ms, updated_at)
VALUES ($1, 1, clock_timestamp(), $2, clock_timestamp())
ON CONFLICT (bucket_key) DO UPDATE SET
  hit_count = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN 1
    ELSE LEAST(b.hit_count + 1, $3::integer + 1)
  END,
  window_start = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN clock_timestamp()
    ELSE b.window_start
  END,
  window_ms = CASE
    WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN EXCLUDED.window_ms
    ELSE b.window_ms
  END,
  updated_at = clock_timestamp()
RETURNING hit_count,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_start + (window_ms * INTERVAL '1 millisecond') - clock_timestamp())) * 1000))::bigint AS retry_after_ms"#;

#[derive(Debug, Clone, Copy)]
pub struct Decision { pub allowed: bool, pub remaining: i64, pub retry_after_ms: i64 }

pub async fn check(pool: &PgPool, key: &str, max: i32, window_ms: i32) -> Result<Decision, AppError> {
    let row: Result<(i32, i64), sqlx::Error> = sqlx::query_as(ATOMIC_RATE_LIMIT_SQL)
        .bind(key).bind(window_ms).bind(max).fetch_one(pool).await;
    match row {
        Ok((hits, retry)) => Ok(Decision { allowed: hits <= max, remaining: (max - hits).max(0) as i64, retry_after_ms: retry }),
        // Fail closed: no in-memory fallback in the gateway (it is always backed by PostgreSQL).
        Err(e) => { eprintln!("rate limit store error: {e}");
            Err(AppError::new(503, "RATE_LIMIT_UNAVAILABLE", "Rate limiting service is temporarily unavailable. Please retry later.")) }
    }
}

pub async fn enforce(pool: &PgPool, key: &str, max: i32, window_ms: i32) -> Result<(), AppError> {
    let d = check(pool, key, max, window_ms).await?;
    if !d.allowed {
        return Err(AppError::new(429, "RATE_LIMITED", &format!(
            "Rate limit exceeded. Please retry after {}s.", (d.retry_after_ms as f64 / 1000.0).ceil() as i64)));
    }
    Ok(())
}
