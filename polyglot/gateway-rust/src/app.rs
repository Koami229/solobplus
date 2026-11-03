//! Router: Core API, reverse proxy to School (Python) / Business (Java), server-rendered UI.
use crate::{demo, admin, admin_ui, review_ui, contribute_ui, business_ui, school_ui, audit, auth, config::Config, crypto, error::AppError, http as h, rate_limit, rbac, ui};
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
        .route("/api/admin", get(admin_get).post(admin_post))
        // 10 MiB file → ~13.4 MiB base64 JSON: the School routes get a 16 MiB body limit, the rest keeps axum's 2 MiB default.
        .route("/api/school/*path", any(proxy_school).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/api/files/:file_id", get(proxy_file))
        .route("/api/business/*path", any(proxy_business))
        .route("/", get(ui_home))
        .route("/login", get(ui_login_page).post(ui_login))
        .route("/logout", post(ui_logout))
        .route("/school", get(school_ui::ui_school))
        .route("/school/upload", post(school_ui::ui_school_upload).layer(axum::extract::DefaultBodyLimit::max(11 * 1024 * 1024)))
        .route("/school/:action", post(school_ui::ui_school_action))
        .route("/business", get(business_ui::ui_business))
        .route("/business/matches", get(business_ui::ui_business_matches))
        .route("/business/:action", post(business_ui::ui_business_action))
        .route("/admin", get(admin_ui::ui_admin))
        .route("/admin/:action", post(admin_ui::ui_admin_action))
        .route("/account", get(admin_ui::ui_account))
        .route("/account/:action", post(admin_ui::ui_account_action))
        .route("/review", get(review_ui::ui_review))
        .route("/review/item/:id", get(review_ui::ui_review_item))
        .route("/review/:action", post(review_ui::ui_review_action))
        .route("/contribute", get(contribute_ui::ui_contribute))
        .route("/contribute/:action", post(contribute_ui::ui_contribute_action))
        .route("/demo", get(demo::hub))
        .route("/demo/business", get(|| async { Redirect::to("/demo/business/accueil") }))
        .route("/demo/school", get(|| async { Redirect::to("/demo/school/tableau-de-bord") }))
        .route("/demo/business/:page", get(demo::business))
        .route("/demo/school/:page", get(demo::school))
        .route("/static/demo.css", get(|| async { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], demo::DEMO_CSS) }))
        .route("/static/home.css", get(|| async { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], demo::HOME_CSS) }))
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
        Some(a @ ("update_privacy" | "export_data")) => {
            let Some((u, _)) = current_user(&s, &hm).await? else { return Err(AppError::new(401, "UNAUTHENTICATED", "Authentication required.")) };
            if a == "update_privacy" {
                let mut r = admin::update_privacy(&s.pool, &u, &v).await?;
                r["ok"] = json!(true);
                Ok(Json(r).into_response())
            } else {
                Ok(Json(json!({"ok": true, "exportPackage": admin::export_data(&s.pool, &u).await?})).into_response())
            }
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

/// GET /api/admin — overview (anonymous allowed; adminDetails only for admin/operator), as in TS.
async fn admin_get(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    let cu = current_user(&s, &hm).await?;
    Ok(Json(json!({"ok": true, "overview": admin::overview(&s.pool, &s.cfg, cu.as_ref().map(|c| &c.0)).await?})).into_response())
}

/// POST /api/admin — seed_synthetic | provision_user | toggle_flag (CSRF, 30/min per client, RBAC + audit in admin.rs).
async fn admin_post(State(s): State<AppState>, method: Method, hm: HeaderMap, body: Bytes) -> Result<Response, AppError> {
    h::enforce_csrf(&method, &hm, None)?;
    let ip = h::client_key(&s.cfg, &hm);
    rate_limit::enforce(&s.pool, &format!("api:admin:{ip}"), 30, 60_000).await?;
    let cu = current_user(&s, &hm).await?;
    let u = cu.as_ref().map(|c| &c.0);
    let v: Value = serde_json::from_slice(&body).map_err(|_| AppError::new(400, "INVALID_JSON", "Request body must be valid JSON."))?;
    match v.get("action").and_then(Value::as_str) {
        Some("seed_synthetic") => { let mut r = admin::seed_synthetic(&s, u).await?; r["ok"] = json!(true); Ok(Json(r).into_response()) }
        Some("provision_user") => Ok((StatusCode::CREATED, Json(json!({"ok": true, "user": admin::provision_user(&s.pool, &s.cfg, u, &v, &ip).await?}))).into_response()),
        Some("toggle_flag") => {
            let key = v.get("key").and_then(Value::as_str).unwrap_or("");
            let en = v.get("enabled").map(|x| x.as_bool().unwrap_or(false)).unwrap_or(false);
            Ok(Json(json!({"ok": true, "flag": admin::toggle_flag(&s.pool, u, key, en).await?})).into_response())
        }
        other => Err(AppError::new(400, "UNKNOWN_ACTION", &format!("Unknown admin action '{}'.", other.unwrap_or("undefined")))),
    }
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
/// GET /api/files/{id}: any authenticated role; routed by `stored_files.pillar` (business → Java, otherwise School).
/// Ownership/visibility is enforced (and denials audited) by the owning service.
async fn proxy_file(State(s): State<AppState>, Path(id): Path<String>, hm: HeaderMap) -> Result<Response, AppError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::new(400, "INVALID_FILE_ID", "Invalid file id."));
    }
    let pillar: Option<String> = sqlx::query_scalar("SELECT pillar FROM stored_files WHERE id = $1").bind(&id).fetch_optional(&s.pool).await?;
    let base = if pillar.as_deref() == Some("business") { s.cfg.business_url.clone() } else { s.cfg.school_url.clone() };
    proxy(s, "core", rbac::ALL_ROLES, base, format!("files/{id}"), Method::GET, hm, Bytes::new()).await
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
    // New public homepage; a signed-in user keeps the account strip (name, role, logout form).
    let strip = match (cu.as_ref(), csrf.as_deref()) {
        (Some((u, _)), Some(c)) => Some(ui::account_strip(u, c)),
        _ => None,
    };
    Ok(demo::home(strip))
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
