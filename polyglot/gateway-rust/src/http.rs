//! Cookies, CSRF (Origin + Fetch-Metadata + double-submit), trusted client IP, security headers.
use crate::{config::Config, crypto, error::AppError};
use axum::http::{HeaderMap, HeaderValue, Method};
use std::collections::HashMap;

pub const SESSION_COOKIE: &str = "solob_session";
pub const CSRF_COOKIE: &str = "solob_csrf";
pub const CSRF_HEADER: &str = "x-solob-csrf";
pub const PROXY_SECRET_HEADER: &str = "x-solob-proxy-secret";

fn h<'a>(hm: &'a HeaderMap, k: &str) -> Option<&'a str> { hm.get(k).and_then(|v| v.to_str().ok()) }

pub fn parse_cookies(hm: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for v in hm.get_all("cookie") {
        if let Ok(s) = v.to_str() {
            for part in s.split(';') {
                if let Some((k, val)) = part.split_once('=') {
                    let k = k.trim();
                    if !k.is_empty() { out.entry(k.to_string()).or_insert_with(|| val.trim().to_string()); }
                }
            }
        }
    }
    out
}

/// Session token from cookie, or `Authorization: Bearer` (API clients).
pub fn session_token(hm: &HeaderMap) -> Option<String> {
    if let Some(c) = parse_cookies(hm).get(SESSION_COOKIE) { if !c.is_empty() { return Some(c.clone()); } }
    h(hm, "authorization").and_then(|a| a.strip_prefix("Bearer ")).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Mirrors enforceCsrfProtection (http.ts). `form_token` supports HTML forms (no JS) as the header equivalent.
pub fn enforce_csrf(method: &Method, hm: &HeaderMap, form_token: Option<&str>) -> Result<(), AppError> {
    if !matches!(*method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE) { return Ok(()); }
    let fail = |m: &str| AppError::new(403, "CSRF_VALIDATION_FAILED", m);
    let expected_host = h(hm, "host").unwrap_or("localhost").to_lowercase();
    if let Some(origin) = h(hm, "origin") {
        let parsed = url::Url::parse(origin).map_err(|_| fail("Malformed Origin header on state-changing request."))?;
        let host = match (parsed.host_str(), parsed.port()) { (Some(hh), Some(p)) => format!("{hh}:{p}"), (Some(hh), None) => hh.to_string(),
            _ => return Err(fail("Malformed Origin header on state-changing request.")) };
        if host.to_lowercase() != expected_host { return Err(fail("Cross-origin state-changing request blocked by CSRF policy.")); }
    }
    if h(hm, "sec-fetch-site").map(|s| s.eq_ignore_ascii_case("cross-site")).unwrap_or(false) {
        return Err(fail("Cross-site state-changing request blocked by Fetch Metadata policy."));
    }
    let cookies = parse_cookies(hm);
    if cookies.get(SESSION_COOKIE).map(|s| !s.is_empty()).unwrap_or(false) {
        let header = h(hm, CSRF_HEADER).map(|s| s.trim().to_string()).or(form_token.map(|s| s.trim().to_string()));
        let Some(header) = header.filter(|s| !s.is_empty()) else {
            return Err(fail("Missing required X-Solob-CSRF header on cookie-authenticated state-changing request."));
        };
        if let Some(c) = cookies.get(CSRF_COOKIE) {
            if !crypto::constant_time_eq(c, &header) { return Err(fail("CSRF token mismatch between X-Solob-CSRF header and solob_csrf cookie.")); }
        }
    }
    Ok(())
}

fn is_ip(s: &str) -> bool { s.parse::<std::net::IpAddr>().is_ok() }

/// Mirrors extractTrustedClientIp (rate-limit.ts): forwarding headers trusted only with the proxy secret.
pub fn client_key(cfg: &Config, hm: &HeaderMap) -> String {
    let mut trusted = false;
    if cfg.trust_proxy {
        trusted = match &cfg.trusted_proxy_secret {
            Some(s) => h(hm, PROXY_SECRET_HEADER).map(|v| crypto::constant_time_eq(v, s)).unwrap_or(false),
            None => !cfg.production,
        };
    }
    if trusted {
        if let Some(xff) = h(hm, "x-forwarded-for") {
            let hops: Vec<&str> = xff.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
            if hops.len() >= cfg.proxy_hops {
                let c = hops[hops.len() - cfg.proxy_hops];
                if is_ip(c) { return format!("proxy-ip:{c}"); }
            }
        }
        if let Some(r) = h(hm, "x-real-ip").map(str::trim) { if is_ip(r) { return format!("proxy-ip:{r}"); } }
    }
    let fp = crypto::sha256_hex(&format!("{}|{}|{}", h(hm, "host").unwrap_or("unknown-host"),
        h(hm, "user-agent").unwrap_or("unknown-ua"), h(hm, "accept-language").unwrap_or("unknown-lang")));
    format!("direct-client:{}", &fp[..20])
}

/// Server-rendered HTML with zero JavaScript lets the CSP drop 'unsafe-inline' for scripts entirely.
pub fn content_security_policy(production: bool) -> String {
    let mut v = vec!["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
        "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"];
    if production { v.push("upgrade-insecure-requests"); }
    v.join("; ")
}

pub fn security_headers(production: bool) -> Vec<(&'static str, String)> {
    let mut v = vec![
        ("content-security-policy", content_security_policy(production)),
        ("x-frame-options", "DENY".into()),
        ("x-content-type-options", "nosniff".into()),
        ("referrer-policy", "strict-origin-when-cross-origin".into()),
        ("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()".into()),
        ("cross-origin-opener-policy", "same-origin".into()),
    ];
    if production { v.push(("strict-transport-security", "max-age=63072000; includeSubDomains".into())); }
    v
}

pub fn session_cookies(cfg: &Config, raw: &str, csrf: &str, max_age_s: i64) -> [HeaderValue; 2] {
    let sec = if cfg.production || cfg.https { "; Secure" } else { "" };
    [
        HeaderValue::from_str(&format!("{SESSION_COOKIE}={raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_s}{sec}")).unwrap(),
        HeaderValue::from_str(&format!("{CSRF_COOKIE}={csrf}; Path=/; SameSite=Lax; Max-Age={max_age_s}{sec}")).unwrap(),
    ]
}

pub fn clear_cookies(cfg: &Config) -> [HeaderValue; 2] {
    let sec = if cfg.production || cfg.https { "; Secure" } else { "" };
    [
        HeaderValue::from_str(&format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{sec}")).unwrap(),
        HeaderValue::from_str(&format!("{CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0{sec}")).unwrap(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs { m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap()); }
        m
    }
    #[test]
    fn csrf_rules() {
        assert!(enforce_csrf(&Method::GET, &hm(&[("origin", "https://evil.com"), ("host", "a")]), None).is_ok());
        assert!(enforce_csrf(&Method::POST, &hm(&[("origin", "https://evil.com"), ("host", "app:3000")]), None).is_err());
        assert!(enforce_csrf(&Method::POST, &hm(&[("origin", "http://app:3000"), ("host", "app:3000")]), None).is_ok());
        assert!(enforce_csrf(&Method::POST, &hm(&[("host", "a"), ("sec-fetch-site", "cross-site")]), None).is_err());
        assert!(enforce_csrf(&Method::POST, &hm(&[("host", "a"), ("cookie", "solob_session=x; solob_csrf=t")]), None).is_err());
        assert!(enforce_csrf(&Method::POST, &hm(&[("host", "a"), ("cookie", "solob_session=x; solob_csrf=t"), ("x-solob-csrf", "u")]), None).is_err());
        assert!(enforce_csrf(&Method::POST, &hm(&[("host", "a"), ("cookie", "solob_session=x; solob_csrf=t"), ("x-solob-csrf", "t")]), None).is_ok());
        assert!(enforce_csrf(&Method::POST, &hm(&[("host", "a"), ("cookie", "solob_session=x; solob_csrf=t")]), Some("t")).is_ok());
    }
    #[test]
    fn proxy_trust() {
        let mut c = Config::test_default();
        let spoof = hm(&[("x-forwarded-for", "1.2.3.4"), ("host", "h")]);
        assert!(client_key(&c, &spoof).starts_with("direct-client:"));
        c.trust_proxy = true; c.trusted_proxy_secret = Some("s".repeat(40)); c.production = true;
        assert!(client_key(&c, &spoof).starts_with("direct-client:"));
        let good = hm(&[("x-forwarded-for", "9.9.9.9, 1.2.3.4"), ("x-solob-proxy-secret", &"s".repeat(40))]);
        assert_eq!(client_key(&c, &good), "proxy-ip:1.2.3.4");
        let bad = hm(&[("x-forwarded-for", "1.2.3.4"), ("x-solob-proxy-secret", "wrong")]);
        assert!(client_key(&c, &bad).starts_with("direct-client:"));
        let legacy = hm(&[("x-forwarded-for", "1.2.3.4"), ("x-proxy-secret", &"s".repeat(40))]);
        assert!(client_key(&c, &legacy).starts_with("direct-client:"));
    }
    #[test]
    fn headers() {
        let dev = security_headers(false);
        assert!(!dev.iter().any(|(k, _)| *k == "strict-transport-security"));
        let p = security_headers(true);
        let mut c = Config::test_default(); c.https = true;
        assert!(session_cookies(&c, "a", "b", 10).iter().all(|v| v.to_str().unwrap().contains("; Secure")));
        assert!(clear_cookies(&c).iter().all(|v| v.to_str().unwrap().contains("; Secure")));
        assert!(session_cookies(&Config::test_default(), "a", "b", 10).iter().all(|v| !v.to_str().unwrap().contains("Secure")));
        assert!(p.iter().any(|(k, _)| *k == "strict-transport-security"));
        assert!(!content_security_policy(true).contains("unsafe-inline"));
    }
}
