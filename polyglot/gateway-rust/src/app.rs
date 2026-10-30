//! Router: Core API, reverse proxy to School (Python) / Business (Java), server-rendered UI.
use crate::{audit, auth, config::Config, crypto, error::AppError, http as h, rate_limit, rbac, ui};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{any, get, post},
    Form, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState { pub pool: PgPool, pub cfg: Arc<Config>, pub http: reqwest::Client }

pub fn router(state: AppState) -> Router {
    let prod = state.cfg.production;
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth", get(me).post(auth_post))
        .route("/api/admin/overview", get(admin_overview))
        .route("/api/school/*path", any(proxy_school))
        .route("/api/business/*path", any(proxy_business))
        .route("/", get(ui_home))
        .route("/login", get(ui_login_page).post(ui_login))
        .route("/logout", post(ui_logout))
        .route("/school", get(ui_pillar))
        .route("/business", get(ui_pillar))
        .route("/admin", get(ui_pillar))
        .route("/static/app.css", get(|| async { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], ui::CSS) }))
        .layer(middleware::from_fn(move |req: Request, next: Next| async move {
            let mut res = next.run(req).await;
            for (k, v) in h::security_headers(prod) { res.headers_mut().insert(k, v.parse().unwrap()); }
            res.headers_mut().remove("x-powered-by");
            res
        }))
        .with_state(state)
}

async fn health(State(s): State<AppState>) -> impl IntoResponse {
    let db = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&s.pool).await.is_ok();
    let code = if db { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(json!({"ok": db, "service": "solob-core-gateway", "database": if db {"up"} else {"down"}})))
}

async fn current_user(s: &AppState, hm: &HeaderMap) -> Result<Option<(rbac::AuthUser, String)>, AppError> {
    let tok = h::session_token(hm);
    Ok(auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?.map(|u| (u, tok.unwrap())))
}

async fn me(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    match current_user(&s, &hm).await? {
        Some((u, tok)) => Ok(Json(json!({"ok": true, "user": u, "csrfToken": crypto::derive_csrf_token(&s.cfg.session_secret, &tok)})).into_response()),
        None => Ok(Json(json!({"ok": true, "user": null})).into_response()),
    }
}

fn with_session(cfg: &Config, mut res: Response, r: &auth::SessionResult) -> Response {
    let max_age = (r.expires_at - chrono::Utc::now()).num_seconds().max(0);
    for c in h::session_cookies(cfg, &r.raw_token, &r.csrf_token, max_age) { res.headers_mut().append(header::SET_COOKIE, c); }
    res
}

async fn auth_post(State(s): State<AppState>, method: Method, hm: HeaderMap, body: Bytes) -> Result<Response, AppError> {
    h::enforce_csrf(&method, &hm, None)?;
    let ip = h::client_key(&s.cfg, &hm);
    let v: Value = serde_json::from_slice(&body).map_err(|_| AppError::new(400, "INVALID_JSON", "Request body must be valid JSON."))?;
    match v.get("action").and_then(Value::as_str) {
        Some("register") => {
            let inp: auth::RegisterInput = serde_json::from_value(v.clone()).unwrap_or_default();
            let r = auth::register(&s.pool, &s.cfg, inp, &ip).await?;
            let res = (StatusCode::CREATED, Json(json!({"ok": true, "user": r.user, "expiresAt": r.expires_at, "csrfToken": r.csrf_token}))).into_response();
            Ok(with_session(&s.cfg, res, &r))
        }
        Some("login") => {
            let g = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
            let r = auth::login(&s.pool, &s.cfg, g("email"), g("password"), &ip).await?;
            let res = Json(json!({"ok": true, "user": r.user, "expiresAt": r.expires_at, "csrfToken": r.csrf_token})).into_response();
            Ok(with_session(&s.cfg, res, &r))
        }
        Some("logout") => {
            let revoked = auth::logout(&s.pool, h::session_token(&hm).as_deref()).await?;
            let mut res = Json(json!({"ok": true, "revoked": revoked})).into_response();
            for c in h::clear_cookies(&s.cfg) { res.headers_mut().append(header::SET_COOKIE, c); }
            Ok(res)
        }
        other => Err(AppError::new(400, "UNKNOWN_ACTION", &format!("Unknown auth action '{}'.", other.unwrap_or("undefined")))),
    }
}

async fn guard(s: &AppState, hm: &HeaderMap, allowed: &[&str], pillar: &str, op: &str) -> Result<(rbac::AuthUser, String), AppError> {
    let cu = current_user(s, hm).await?;
    if let Err(e) = rbac::check_role(cu.as_ref().map(|c| &c.0), allowed, pillar, op) {
        let actor = cu.as_ref().map(|c| (c.0.id.as_str(), c.0.role.as_str()));
        audit::record(&s.pool, actor, pillar, op, if e.code == "FORBIDDEN_ROLE" {"RBAC_GUARD"} else {"AUTH_GUARD"}, None, "DENIED", None,
            json!({"reason": e.code, "allowedRoles": allowed})).await;
        return Err(e);
    }
    Ok(cu.unwrap())
}

async fn admin_overview(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    guard(&s, &hm, &["admin"], "core", "ADMIN_OVERVIEW").await?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&s.pool).await?;
    let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events").fetch_one(&s.pool).await?;
    Ok(Json(json!({"ok": true, "users": users, "auditEvents": audits})).into_response())
}

async fn proxy(s: AppState, pillar: &'static str, allowed: &[&str], base: String, path: String, method: Method, hm: HeaderMap, body: Bytes) -> Result<Response, AppError> {
    h::enforce_csrf(&method, &hm, None)?;
    let (user, _) = guard(&s, &hm, allowed, pillar, &format!("{}_{}", pillar.to_uppercase(), method)).await?;
    if method != Method::GET {
        rate_limit::enforce(&s.pool, &format!("{pillar}:mutation:user:{}", user.id), 60, 60_000).await?;
    }
    if path.split('/').any(|seg| seg == ".." || seg.is_empty() && false) { return Err(AppError::new(400, "BAD_PATH", "Invalid path.")); }
    let url = format!("{}/{}", base.trim_end_matches('/'), path);
    let m = reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap();
    let mut rb = s.http.request(m, &url)
        .header("x-solob-service-secret", &s.cfg.service_secret)
        .header("x-solob-user-id", &user.id).header("x-solob-user-role", &user.role)
        .header("x-solob-user-email", &user.email).header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(15));
    if !body.is_empty() { rb = rb.body(body.to_vec()); }
    let r = rb.send().await.map_err(|e| { eprintln!("upstream {pillar} error: {e}");
        AppError::new(502, "UPSTREAM_UNAVAILABLE", &format!("SOLOB {pillar} service is unavailable.")) })?;
    let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let bytes = r.bytes().await.map_err(|_| AppError::new(502, "UPSTREAM_UNAVAILABLE", "Upstream read failed."))?;
    Ok(Response::builder().status(status).header(header::CONTENT_TYPE, "application/json").body(Body::from(bytes)).unwrap())
}

async fn proxy_school(State(s): State<AppState>, Path(p): Path<String>, m: Method, hm: HeaderMap, b: Bytes) -> Result<Response, AppError> {
    let base = s.cfg.school_url.clone();
    proxy(s, "school", rbac::SCHOOL_ROLES, base, p, m, hm, b).await
}
async fn proxy_business(State(s): State<AppState>, Path(p): Path<String>, m: Method, hm: HeaderMap, b: Bytes) -> Result<Response, AppError> {
    let base = s.cfg.business_url.clone();
    proxy(s, "business", rbac::BUSINESS_ROLES, base, p, m, hm, b).await
}

// ---------------- server-rendered UI (no JavaScript) ----------------
fn html(body: String) -> Response { ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response() }

async fn ui_home(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    let cu = current_user(&s, &hm).await?;
    let csrf = cu.as_ref().map(|(_, t)| crypto::derive_csrf_token(&s.cfg.session_secret, t));
    Ok(html(ui::home(cu.as_ref().map(|c| &c.0), csrf.as_deref())))
}
async fn ui_login_page() -> Response { html(ui::login(None)) }

#[derive(Deserialize)]
struct LoginForm { email: String, password: String }
async fn ui_login(State(s): State<AppState>, hm: HeaderMap, Form(f): Form<LoginForm>) -> Result<Response, AppError> {
    h::enforce_csrf(&Method::POST, &hm, None)?;
    let ip = h::client_key(&s.cfg, &hm);
    match auth::login(&s.pool, &s.cfg, Some(f.email), Some(f.password), &ip).await {
        Ok(r) => Ok(with_session(&s.cfg, Redirect::to("/").into_response(), &r)),
        Err(e) if e.status == 401 || e.status == 400 => Ok((StatusCode::UNAUTHORIZED, html(ui::login(Some("Email ou mot de passe invalide.")))).into_response()),
        Err(e) => Err(e),
    }
}
#[derive(Deserialize)]
struct CsrfForm { csrf: String }
async fn ui_logout(State(s): State<AppState>, hm: HeaderMap, Form(f): Form<CsrfForm>) -> Result<Response, AppError> {
    h::enforce_csrf(&Method::POST, &hm, Some(&f.csrf))?;
    let tok = h::session_token(&hm);
    if let Some(t) = &tok { if !crypto::verify_csrf_token(&s.cfg.session_secret, t, &f.csrf) {
        return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); } }
    auth::logout(&s.pool, tok.as_deref()).await?;
    let mut res = Redirect::to("/").into_response();
    for c in h::clear_cookies(&s.cfg) { res.headers_mut().append(header::SET_COOKIE, c); }
    Ok(res)
}
async fn ui_pillar(State(s): State<AppState>, hm: HeaderMap, uri: axum::http::Uri) -> Result<Response, AppError> {
    let cu = current_user(&s, &hm).await?;
    let (allowed, title): (&[&str], &str) = match uri.path() {
        "/school" => (rbac::SCHOOL_ROLES, "SOLOB School"), "/business" => (rbac::BUSINESS_ROLES, "SOLOB Business"), _ => (&["admin"], "SOLOB Core — Administration") };
    let u = cu.as_ref().map(|c| &c.0);
    let denied = rbac::check_role(u, allowed, "core", "UI").err();
    let status = denied.as_ref().map(|e| StatusCode::from_u16(e.status).unwrap()).unwrap_or(StatusCode::OK);
    Ok((status, html(ui::pillar(title, u, denied.map(|e| e.message))) ).into_response())
}
