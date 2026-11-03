//! Registration, login, sessions, logout, initial admin bootstrap (mirrors src/lib/core/auth.ts).
use crate::{audit, config::Config, crypto, error::AppError, rate_limit, rbac::{self, AuthUser}};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, Row};

pub fn is_synthetic_email(e: &str) -> bool { e.trim().to_lowercase().ends_with("@synthetic.solob.local") }

fn valid_email(e: &str) -> bool {
    let Some((l, d)) = e.split_once('@') else { return false };
    !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !e.contains(char::is_whitespace) && e.len() <= 180
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegisterInput {
    pub email: Option<String>, pub password: Option<String>, pub full_name: Option<String>, pub role: Option<String>,
    pub preferred_ui_lang: Option<String>, pub country_code: Option<String>,
    pub voice_data_consent: Option<bool>, pub linguistic_data_consent: Option<bool>,
}

pub struct SessionResult { pub user: AuthUser, pub raw_token: String, pub csrf_token: String, pub expires_at: DateTime<Utc> }

async fn create_session(pool: &PgPool, cfg: &Config, user_id: &str, ip: &str) -> Result<(String, DateTime<Utc>), AppError> {
    let (raw, hash) = crypto::generate_session_token(&cfg.session_secret);
    let exp = Utc::now() + Duration::hours(cfg.session_ttl_hours);
    sqlx::query("INSERT INTO sessions (id, user_id, token_hash, ip_address, expires_at) VALUES ($1,$2,$3,$4,$5)")
        .bind(crypto::create_id("ses")).bind(user_id).bind(hash).bind(ip).bind(exp).execute(pool).await?;
    Ok((raw, exp))
}

pub async fn register(pool: &PgPool, cfg: &Config, inp: RegisterInput, ip: &str) -> Result<SessionResult, AppError> {
    let email = inp.email.as_deref().map(|e| e.trim().to_lowercase()).unwrap_or_else(|| "unknown".into());
    rate_limit::enforce(pool, &format!("auth:register:client:{ip}"), 15, 60_000).await?;
    if email != "unknown" { rate_limit::enforce(pool, &format!("auth:register:email:{email}"), 5, 60_000).await?; }
    let role = inp.role.as_deref().unwrap_or("").trim().to_string();
    if rbac::PRIVILEGED_OR_VERIFIED_ROLES.contains(&role.as_str()) {
        audit::record(pool, None, "core", "USER_REGISTER_PRIVILEGED_ROLE_DENIED", "user", None, "DENIED", Some(ip),
            json!({"email": email, "attemptedRole": role})).await;
        return Err(AppError::new(403, "PRIVILEGED_ROLE_FORBIDDEN", &format!(
            "Public self-registration for privileged or verification-required role '{role}' is forbidden.")));
    }
    let mut issues = vec![];
    if !valid_email(&email) { issues.push("Invalid email"); }
    let pw = inp.password.unwrap_or_default();
    if pw.chars().count() < 8 || pw.chars().count() > 128 { issues.push("Password must be 8-128 characters"); }
    let name = inp.full_name.unwrap_or_default().trim().to_string();
    if name.chars().count() < 2 || name.chars().count() > 120 { issues.push("Full name must be 2-120 characters"); }
    if !rbac::PUBLIC_SELF_REGISTER_ROLES.contains(&role.as_str()) { issues.push("Invalid role"); }
    let lang = inp.preferred_ui_lang.unwrap_or_else(|| "fr".into());
    if lang != "fr" && lang != "en" { issues.push("Invalid language"); }
    let cc = inp.country_code.unwrap_or_else(|| "BJ".into()).trim().to_uppercase();
    if cc.len() < 2 || cc.len() > 4 { issues.push("Invalid country code"); }
    if !issues.is_empty() {
        return Err(AppError::new(400, "VALIDATION_ERROR", &format!("Invalid registration input: {}", issues.join(", "))));
    }
    if cfg.production && is_synthetic_email(&email) {
        return Err(AppError::new(403, "SYNTHETIC_ACCOUNT_FORBIDDEN_IN_PROD", "Synthetic demo accounts are disabled in production."));
    }
    let id = crypto::create_id("usr");
    let pillar = rbac::pillar_for_role(&role);
    let hash = crypto::hash_password(&pw);
    let r = sqlx::query("INSERT INTO users (id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code, voice_data_consent, linguistic_data_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(&id).bind(&email).bind(&hash).bind(&name).bind(&role).bind(pillar).bind(&lang).bind(&cc)
        .bind(inp.voice_data_consent.unwrap_or(false)).bind(inp.linguistic_data_consent.unwrap_or(false)).execute(pool).await;
    if let Err(sqlx::Error::Database(d)) = &r {
        if d.is_unique_violation() { return Err(AppError::new(409, "EMAIL_ALREADY_EXISTS", "An account with this email already exists.")); }
    }
    r?;
    audit::record(pool, Some((&id, &role)), pillar, "USER_REGISTER", "user", Some(&id), "SUCCESS", Some(ip), json!({"email": email, "role": role})).await;
    let (raw, exp) = create_session(pool, cfg, &id, ip).await?;
    let user = AuthUser { id, email, full_name: name, role: role.clone(), pillar: pillar.into(), preferred_ui_lang: lang, country_code: cc, is_active: true };
    Ok(SessionResult { csrf_token: crypto::derive_csrf_token(&cfg.session_secret, &raw), user, raw_token: raw, expires_at: exp })
}

fn row_user(r: &sqlx::postgres::PgRow) -> AuthUser {
    AuthUser { id: r.get("id"), email: r.get("email"), full_name: r.get("full_name"), role: r.get("role"), pillar: r.get("pillar"),
        preferred_ui_lang: r.get("preferred_ui_lang"), country_code: r.get("country_code"), is_active: r.get("is_active") }
}

pub async fn login(pool: &PgPool, cfg: &Config, email: Option<String>, password: Option<String>, ip: &str) -> Result<SessionResult, AppError> {
    let email = email.map(|e| e.trim().to_lowercase()).unwrap_or_else(|| "unknown".into());
    rate_limit::enforce(pool, &format!("auth:login:client:{ip}"), 15, 60_000).await?;
    if email != "unknown" { rate_limit::enforce(pool, &format!("auth:login:email:{email}"), 10, 60_000).await?; }
    let pw = password.unwrap_or_default();
    if !valid_email(&email) || pw.is_empty() || pw.len() > 128 {
        return Err(AppError::new(400, "VALIDATION_ERROR", "Invalid login credentials format."));
    }
    if cfg.production && is_synthetic_email(&email) {
        audit::record(pool, None, "core", "USER_LOGIN_SYNTHETIC_BLOCKED_IN_PROD", "user", None, "DENIED", Some(ip), json!({"email": email})).await;
        return Err(AppError::new(403, "SYNTHETIC_ACCOUNT_FORBIDDEN_IN_PROD", "Synthetic demo accounts are disabled in production."));
    }
    let row = sqlx::query("SELECT id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code, is_active FROM users WHERE email = $1")
        .bind(&email).fetch_optional(pool).await?;
    let invalid = || AppError::new(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    let Some(row) = row else {
        crypto::verify_password(&pw, "scrypt$16384$8$1$00$00"); // keep timing similar for unknown users
        audit::record(pool, None, "core", "USER_LOGIN", "user", None, "DENIED", Some(ip), json!({"email": email, "reason": "UNKNOWN_EMAIL"})).await;
        return Err(invalid());
    };
    let user = row_user(&row);
    let hash: String = row.get("password_hash");
    if !crypto::verify_password(&pw, &hash) {
        audit::record(pool, Some((&user.id, &user.role)), &user.pillar, "USER_LOGIN", "user", Some(&user.id), "DENIED", Some(ip), json!({"reason": "BAD_PASSWORD"})).await;
        return Err(invalid());
    }
    if !user.is_active { return Err(AppError::new(403, "ACCOUNT_DEACTIVATED", "Account is deactivated.")); }
    let (raw, exp) = create_session(pool, cfg, &user.id, ip).await?;
    audit::record(pool, Some((&user.id, &user.role)), &user.pillar, "USER_LOGIN", "user", Some(&user.id), "SUCCESS", Some(ip), json!({})).await;
    Ok(SessionResult { csrf_token: crypto::derive_csrf_token(&cfg.session_secret, &raw), user, raw_token: raw, expires_at: exp })
}

pub async fn authenticate(pool: &PgPool, cfg: &Config, raw: Option<&str>) -> Result<Option<AuthUser>, AppError> {
    let Some(raw) = raw else { return Ok(None) };
    if !crypto::verify_session_token_format(&cfg.session_secret, raw) { return Ok(None); }
    let row = sqlx::query("SELECT s.expires_at, s.revoked_at, u.id, u.email, u.full_name, u.role, u.pillar, u.preferred_ui_lang, u.country_code, u.is_active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1")
        .bind(crypto::sha256_hex(raw)).fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(None) };
    let revoked: Option<DateTime<Utc>> = row.get("revoked_at");
    let exp: DateTime<Utc> = row.get("expires_at");
    let u = row_user(&row);
    if revoked.is_some() || !u.is_active || exp <= Utc::now() { return Ok(None); }
    if cfg.production && is_synthetic_email(&u.email) { return Ok(None); }
    Ok(Some(u))
}

pub async fn logout(pool: &PgPool, raw: Option<&str>) -> Result<bool, AppError> {
    let Some(raw) = raw else { return Ok(false) };
    let r = sqlx::query("UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL")
        .bind(crypto::sha256_hex(raw)).execute(pool).await?;
    Ok(r.rows_affected() > 0)
}

/// One-time initial admin: advisory xact lock + system_bootstrap singleton (migration 003).
pub async fn bootstrap_initial_admin(pool: &PgPool, email: &str, password: &str, full_name: &str, country: &str) -> Result<String, AppError> {
    let email = email.trim().to_lowercase();
    if !valid_email(&email) { return Err(AppError::new(400, "INVALID_BOOTSTRAP_ADMIN_EMAIL", "Bootstrap administrator email is invalid.")); }
    if is_synthetic_email(&email) { return Err(AppError::new(400, "INVALID_BOOTSTRAP_ADMIN_EMAIL", "Synthetic emails cannot be used for the administrator.")); }
    if password.chars().count() < 12 || password.chars().count() > 128 {
        return Err(AppError::new(400, "WEAK_BOOTSTRAP_ADMIN_PASSWORD", "Bootstrap administrator password must be 12-128 characters."));
    }
    let name = full_name.trim();
    if name.chars().count() < 2 || name.chars().count() > 120 { return Err(AppError::new(400, "INVALID_BOOTSTRAP_ADMIN_NAME", "Bootstrap administrator name must be 2-120 characters.")); }
    let cc = country.trim().to_uppercase();
    if cc.len() != 2 || !cc.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(AppError::new(400, "INVALID_BOOTSTRAP_ADMIN_COUNTRY", "Bootstrap administrator country must be an ISO 3166-1 alpha-2 code."));
    }
    let already = || AppError::new(409, "ADMIN_ALREADY_BOOTSTRAPPED", "An initial administrator already exists. One-time bootstrap cannot be re-run.");
    let id = crypto::create_id("usr");
    let hash = crypto::hash_password(password);
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('solob_plus_initial_admin_bootstrap'))").execute(&mut *tx).await?;
    let admin: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE LIMIT 1").fetch_optional(&mut *tx).await?;
    let marker: Option<String> = sqlx::query_scalar("SELECT bootstrap_key FROM system_bootstrap WHERE bootstrap_key = 'initial_admin'").fetch_optional(&mut *tx).await?;
    if admin.is_some() || marker.is_some() { return Err(already()); }
    let dup: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1").bind(&email).fetch_optional(&mut *tx).await?;
    if dup.is_some() { return Err(AppError::new(409, "EMAIL_ALREADY_EXISTS", "An account with this email already exists.")); }
    sqlx::query("INSERT INTO users (id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code, voice_data_consent, linguistic_data_consent) VALUES ($1,$2,$3,$4,'admin','core','fr',$5,FALSE,FALSE)")
        .bind(&id).bind(&email).bind(&hash).bind(name).bind(&cc).execute(&mut *tx).await?;
    let claimed: Option<String> = sqlx::query_scalar("INSERT INTO system_bootstrap (bootstrap_key, admin_user_id) VALUES ('initial_admin', $1) ON CONFLICT (bootstrap_key) DO NOTHING RETURNING bootstrap_key")
        .bind(&id).fetch_optional(&mut *tx).await?;
    if claimed.is_none() { return Err(already()); }
    tx.commit().await?;
    audit::record(pool, Some((&id, "admin")), "core", "ADMIN_BOOTSTRAP_INITIAL", "user", Some(&id), "SUCCESS", Some("cli-bootstrap"),
        json!({"email": email, "role": "admin", "countryCode": cc})).await;
    Ok(id)
}
