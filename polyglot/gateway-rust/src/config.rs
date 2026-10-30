//! Configuration loading and fail-fast validation (mirrors src/lib/core/config.ts + crypto.ts).
use crate::error::AppError;

pub const LOCAL_DEV_ONLY_FALLBACK_SECRET: &str = "solob-local-dev-only-ephemeral-hmac-key-2026";
const PLACEHOLDERS: &[&str] = &[
    "replace_with_64_char_hex_session_secret_do_not_commit",
    "solob-dev-ephemeral-hmac-key-not-for-prod",
    "dev-only-solob-plus-hmac-secret-replace-in-prod-2026",
    "changeme",
    "ephemeral-hmac-key",
];

#[derive(Clone, Debug)]
pub struct Config {
    pub production: bool,
    pub session_secret: String,
    pub session_ttl_hours: i64,
    pub trust_proxy: bool,
    pub trusted_proxy_secret: Option<String>,
    pub proxy_hops: usize,
    pub service_secret: String,
    pub school_url: String,
    pub business_url: String,
    pub allow_memory_rate_limit_fallback: bool,
}

fn is_placeholder(s: &str) -> bool {
    let l = s.trim().to_lowercase();
    PLACEHOLDERS.iter().any(|p| l == *p) || l.contains("replace_with") || l.contains("changeme")
}

/// Validate a session secret. Production requires >= 32 chars, not a placeholder.
pub fn validate_session_secret(raw: Option<&str>, production: bool) -> Result<String, AppError> {
    let t = raw.unwrap_or("").trim();
    if production {
        if t.len() < 32 || is_placeholder(t) {
            return Err(AppError::new(500, "INVALID_SESSION_SECRET",
                "FATAL: SESSION_SECRET must be set to a non-placeholder value of at least 32 characters in production."));
        }
        return Ok(t.to_string());
    }
    if t.is_empty() || is_placeholder(t) {
        return Ok(LOCAL_DEV_ONLY_FALLBACK_SECRET.to_string());
    }
    Ok(t.to_string())
}

pub fn validate_proxy(trust: Option<&str>, secret: Option<&str>, production: bool) -> Result<(bool, Option<String>), AppError> {
    let t = trust.unwrap_or("").trim().to_lowercase();
    let trust = match t.as_str() {
        "" | "false" => false,
        "true" => true,
        _ => return Err(AppError::new(500, "INVALID_PROXY_CONFIG", "FATAL: TRUST_PROXY must be \"true\" or \"false\".")),
    };
    let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if trust && production {
        match &secret {
            Some(s) if s.len() >= 32 && !is_placeholder(s) => {}
            _ => return Err(AppError::new(500, "INVALID_PROXY_CONFIG",
                "FATAL: TRUST_PROXY=true in production requires a non-placeholder TRUSTED_PROXY_SECRET of at least 32 characters.")),
        }
    }
    Ok((trust, secret))
}

pub const DEV_ONLY_SERVICE_SECRET: &str = "solob-local-dev-only-service-secret-2026";

/// SERVICE_SECRET rule shared with School (Python) and Business (Java):
/// a provided value must be >= 32 chars and not a placeholder in every environment; when missing,
/// only APP_ENV=development|test gets the dev-only fallback; anything else (incl. unset APP_ENV) refuses to start.
pub fn validate_service_secret(raw: Option<&str>, app_env: Option<&str>) -> Result<String, AppError> {
    let s = raw.unwrap_or("").trim();
    let dev = matches!(app_env.map(|e| e.trim().to_lowercase()).as_deref(), Some("development") | Some("test"));
    if !s.is_empty() {
        if s.len() < 32 || is_placeholder(s) {
            return Err(AppError::new(500, "INVALID_SERVICE_SECRET", "FATAL: SERVICE_SECRET must be a non-placeholder value of at least 32 characters."));
        }
        return Ok(s.to_string());
    }
    if dev { return Ok(DEV_ONLY_SERVICE_SECRET.to_string()); }
    Err(AppError::new(500, "INVALID_SERVICE_SECRET", "FATAL: SERVICE_SECRET (>= 32 chars) is required outside APP_ENV=development|test."))
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        let g = |k: &str| std::env::var(k).ok();
        let production = matches!(g("APP_ENV").or(g("NODE_ENV")).as_deref(), Some("production"));
        let session_secret = validate_session_secret(g("SESSION_SECRET").as_deref(), production)?;
        let (trust_proxy, trusted_proxy_secret) =
            validate_proxy(g("TRUST_PROXY").as_deref(), g("TRUSTED_PROXY_SECRET").as_deref(), production)?;
        let service_secret = validate_service_secret(g("SERVICE_SECRET").as_deref(), g("APP_ENV").as_deref())?;
        Ok(Config {
            production,
            session_secret,
            session_ttl_hours: g("SESSION_TTL_HOURS").and_then(|v| v.parse().ok()).unwrap_or(168),
            trust_proxy,
            trusted_proxy_secret,
            proxy_hops: g("TRUSTED_PROXY_HOPS").and_then(|v| v.parse().ok()).filter(|h: &usize| *h >= 1).unwrap_or(1),
            service_secret,
            school_url: g("SCHOOL_SERVICE_URL").unwrap_or_else(|| "http://127.0.0.1:8101".into()),
            business_url: g("BUSINESS_SERVICE_URL").unwrap_or_else(|| "http://127.0.0.1:8102".into()),
            allow_memory_rate_limit_fallback: !production,
        })
    }

    pub fn test_default() -> Self {
        Config {
            production: false,
            session_secret: "test-only-secret-0123456789abcdef0123456789abcdef".into(),
            session_ttl_hours: 168,
            trust_proxy: false,
            trusted_proxy_secret: None,
            proxy_hops: 1,
            service_secret: "test-service-secret-0123456789abcdef".into(),
            school_url: "http://127.0.0.1:1".into(),
            business_url: "http://127.0.0.1:1".into(),
            allow_memory_rate_limit_fallback: false,
        }
    }
}
