use serde_json::Value;
use sqlx::PgPool;

/// Best-effort audit write (never contains passwords, hashes or secrets).
pub async fn record(pool: &PgPool, actor: Option<(&str, &str)>, pillar: &str, action: &str,
                    target_type: &str, target_id: Option<&str>, status: &str, ip: Option<&str>, meta: Value) {
    let r = sqlx::query("INSERT INTO audit_events (id, actor_user_id, actor_role, pillar, action, target_type, target_id, status, redacted_metadata_json, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(crate::crypto::create_id("aud")).bind(actor.map(|a| a.0)).bind(actor.map(|a| a.1))
        .bind(pillar).bind(action).bind(target_type).bind(target_id).bind(status).bind(meta).bind(ip)
        .execute(pool).await;
    if let Err(e) = r { eprintln!("audit write failed: {e}"); }
}
