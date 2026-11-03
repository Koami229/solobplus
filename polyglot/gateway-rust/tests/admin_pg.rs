//! Admin / privacy / export / seed against PostgreSQL 16 (Phase 4). Upstreams are unreachable on purpose (127.0.0.1:1):
//! the seed must still create Core accounts and report pillar items as 502.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, config::{self, Config}, crypto, db};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

async fn fresh_db() -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    Some(pool)
}

async fn send(r: &Router, req: Request<Body>) -> (StatusCode, Vec<String>, String) {
    let res = r.clone().oneshot(req).await.unwrap();
    let st = res.status();
    let ck = res.headers().get_all("set-cookie").iter().map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string()).collect();
    (st, ck, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}
fn jpost(uri: &str, ck: &str, csrf: &str, body: Value) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("x-solob-csrf", csrf).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
}
fn form(uri: &str, ck: &str, body: &str) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
}

/// Registers a user then promotes it directly in SQL (test-only), logs in, returns (cookie, csrf).
async fn user(r: &Router, pool: &PgPool, email: &str, role: &str) -> (String, String) {
    let (st, _, b) = send(r, jpost("/api/auth", "", "", json!({"action":"register","email":email,"password":"Password123!","fullName":"Test U","role":"student"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{b}");
    sqlx::query("UPDATE users SET role=$2, pillar=CASE WHEN $2 IN ('admin','operator') THEN 'core' ELSE pillar END WHERE email=$1").bind(email).bind(role).execute(pool).await.unwrap();
    let (st, ck, _) = send(r, jpost("/api/auth", "", "", json!({"action":"login","email":email,"password":"Password123!"}))).await;
    assert_eq!(st, StatusCode::OK);
    let s = ck.iter().find_map(|c| c.strip_prefix("solob_session=")).unwrap().to_string();
    let c = ck.iter().find_map(|c| c.strip_prefix("solob_csrf=")).unwrap().to_string();
    (format!("solob_session={s}; solob_csrf={c}"), c)
}

async fn setup(prod: bool) -> Option<(Router, PgPool)> {
    let pool = fresh_db().await?;
    let mut cfg = Config::test_default(); cfg.production = prod;
    Some((app::router(app::AppState { pool: pool.clone(), cfg: Arc::new(cfg), http: reqwest::Client::new() }), pool))
}

async fn audits(pool: &PgPool, action: &str, status: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action=$1 AND status=$2").bind(action).bind(status).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn provision_user_rbac_matrix() {
    let Some((r, pool)) = setup(false).await else { return };
    let (adm, ac) = user(&r, &pool, "adm@e.org", "admin").await;
    let (op, oc) = user(&r, &pool, "op@e.org", "operator").await;
    let (st_, sc) = user(&r, &pool, "stu@e.org", "student").await;
    let body = |e: &str, role: &str| json!({"action":"provision_user","email":e,"password":"Password123!","fullName":"New User","role":role});
    assert_eq!(send(&r, jpost("/api/admin", &st_, &sc, body("a@e.org", "teacher"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, jpost("/api/admin", "", "", body("a@e.org", "teacher"))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, jpost("/api/admin", &op, &oc, body("rev@e.org", "reviewer"))).await.0, StatusCode::CREATED);
    assert_eq!(send(&r, jpost("/api/admin", &op, &oc, body("op2@e.org", "operator"))).await.0, StatusCode::FORBIDDEN, "operator cannot mint operators");
    assert_eq!(audits(&pool, "PROVISION_PRIVILEGED_USER", "DENIED").await, 1);
    let (st, _, b) = send(&r, jpost("/api/admin", &adm, &ac, body("op2@e.org", "operator"))).await;
    assert_eq!(st, StatusCode::CREATED, "{b}");
    assert!(!b.contains("password"), "no hash leak");
    assert_eq!(send(&r, jpost("/api/admin", &adm, &ac, body("op2@e.org", "operator"))).await.0, StatusCode::CONFLICT);
    assert_eq!(send(&r, jpost("/api/admin", &adm, &ac, json!({"action":"provision_user","email":"bad","password":"x","fullName":"N","role":"god"}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(audits(&pool, "ADMIN_USER_PROVISIONED", "SUCCESS").await, 2);
    // the provisioned account can log in with its initial password
    assert_eq!(send(&r, jpost("/api/auth", "", "", json!({"action":"login","email":"rev@e.org","password":"Password123!"}))).await.0, StatusCode::OK);
    // no session was left behind for provisioned accounts
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='op2@e.org'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn toggle_flag_admin_only_and_live_payments_locked() {
    let Some((r, pool)) = setup(false).await else { return };
    let (adm, ac) = user(&r, &pool, "adm@e.org", "admin").await;
    let (op, oc) = user(&r, &pool, "op@e.org", "operator").await;
    let t = |k: &str, e: bool| json!({"action":"toggle_flag","key":k,"enabled":e});
    assert_eq!(send(&r, jpost("/api/admin", &op, &oc, t("school.grounded_ai_tutor", false))).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, jpost("/api/admin", &adm, &ac, t("school.grounded_ai_tutor", false))).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["flag"]["enabled"], false);
    if std::env::var("PAYMENT_PROVIDER").map(|v| v.is_empty() || v == "disabled").unwrap_or(true) {
        let (st, _, b) = send(&r, jpost("/api/admin", &adm, &ac, t("business.live_payment_transfers", true))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST); assert!(b.contains("LIVE_PAYMENT_PROVIDER_DISABLED"));
        let on: bool = sqlx::query_scalar("SELECT enabled FROM feature_flags WHERE key='business.live_payment_transfers'").fetch_one(&pool).await.unwrap();
        assert!(!on);
    }
    assert_eq!(send(&r, jpost("/api/admin", &adm, &ac, t("nope.flag", true))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(audits(&pool, "FEATURE_FLAG_TOGGLED", "SUCCESS").await, 1);
    // missing CSRF header with a session cookie → 403
    let req = Request::post("/api/admin").header("host", "app.test").header("cookie", &adm).header("content-type", "application/json").body(Body::from(t("school.grounded_ai_tutor", true).to_string())).unwrap();
    assert_eq!(send(&r, req).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn privacy_and_export_are_self_scoped_and_audited() {
    let Some((r, pool)) = setup(false).await else { return };
    let (ck, c) = user(&r, &pool, "me@e.org", "contributor").await;
    let (_o, _) = user(&r, &pool, "other@e.org", "student").await;
    assert_eq!(send(&r, jpost("/api/auth", "", "", json!({"action":"export_data"}))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, jpost("/api/auth", &ck, &c, json!({"action":"update_privacy","privacyRetentionDays":10}))).await.0, StatusCode::BAD_REQUEST);
    let (st, _, b) = send(&r, jpost("/api/auth", &ck, &c, json!({"action":"update_privacy","privacyRetentionDays":90,"marketingConsent":true}))).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    let (d, m): (i32, bool) = sqlx::query_as("SELECT privacy_retention_days, marketing_consent FROM users WHERE email='me@e.org'").fetch_one(&pool).await.unwrap();
    assert_eq!((d, m), (90, true));
    let (st, _, b) = send(&r, jpost("/api/auth", &ck, &c, json!({"action":"export_data"}))).await;
    assert_eq!(st, StatusCode::OK);
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["exportPackage"]["account"]["email"], "me@e.org");
    assert!(!b.contains("other@e.org") && !b.contains("password_hash"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM privacy_requests").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 2);
    assert_eq!(audits(&pool, "USER_DATA_EXPORTED", "SUCCESS").await, 1);
    assert_eq!(audits(&pool, "PRIVACY_CONSENT_UPDATED", "SUCCESS").await, 1);
    // HTML account page: forms + CSRF, export download
    let (st, _, html) = send(&r, Request::get("/account").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK); assert!(html.contains("/account/export_data") && html.contains(&c));
    assert_eq!(send(&r, form("/account/export_data", &ck, "csrf=forged")).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, form("/account/export_data", &ck, &format!("csrf={c}"))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("\"exportId\""));
}

#[tokio::test]
async fn seed_synthetic_dev_only_admin_only_idempotent() {
    let Some((r, pool)) = setup(false).await else { return };
    let (adm, ac) = user(&r, &pool, "adm@e.org", "admin").await;
    let (op, oc) = user(&r, &pool, "op@e.org", "operator").await;
    assert_eq!(send(&r, jpost("/api/admin", &op, &oc, json!({"action":"seed_synthetic"}))).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, jpost("/api/admin", &adm, &ac, json!({"action":"seed_synthetic"}))).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    let v: Value = serde_json::from_str(&b).unwrap();
    assert_eq!(v["alreadySeeded"], false);
    assert!(v["pillarData"].as_array().unwrap().iter().all(|p| p["status"] == 502), "upstreams down in this test");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email LIKE '%@synthetic.solob.local' AND full_name LIKE '[SYNTHETIC]%'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 8);
    let (_, _, b) = send(&r, jpost("/api/admin", &adm, &ac, json!({"action":"seed_synthetic"}))).await;
    assert!(b.contains("\"alreadySeeded\":true"));
    assert_eq!(send(&r, jpost("/api/auth", "", "", json!({"action":"login","email":"admin@synthetic.solob.local","password":"SolobSynthetic#2026"}))).await.0, StatusCode::OK);
    assert_eq!(send(&r, jpost("/api/admin", &adm, &ac, json!({"action":"bogus"}))).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn seed_is_forbidden_in_production() {
    let Some((r, pool)) = setup(true).await else { return };
    // production cookies are __Host- prefixed; create the admin + session straight in SQL.
    let id = crypto::create_id("usr");
    sqlx::query("INSERT INTO users (id,email,password_hash,full_name,role,pillar) VALUES ($1,'root@e.org','x','Root','admin','core')").bind(&id).execute(&pool).await.unwrap();
    let cfg = Config::test_default();
    let (raw, hash) = crypto::generate_session_token(&cfg.session_secret);
    sqlx::query("INSERT INTO sessions (id,user_id,token_hash,ip_address,expires_at) VALUES ($1,$2,$3,'t',NOW()+INTERVAL '1 hour')").bind(crypto::create_id("ses")).bind(&id).bind(hash).execute(&pool).await.unwrap();
    let csrf = crypto::derive_csrf_token(&cfg.session_secret, &raw);
    let ck = format!("solob_session={raw}; solob_csrf={csrf}");
    let (st, _, b) = send(&r, jpost("/api/admin", &ck, &csrf, json!({"action":"seed_synthetic"}))).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{b}"); assert!(b.contains("SEED_FORBIDDEN_IN_PRODUCTION"));
    assert_eq!(audits(&pool, "SYNTHETIC_SEED_BLOCKED_IN_PRODUCTION", "DENIED").await, 1);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email LIKE '%@synthetic.solob.local'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn admin_html_console_rbac_csrf_and_actions() {
    let Some((r, pool)) = setup(false).await else { return };
    let (adm, ac) = user(&r, &pool, "adm@e.org", "admin").await;
    let (op, _) = user(&r, &pool, "op@e.org", "operator").await;
    let (stu, sc) = user(&r, &pool, "stu@e.org", "student").await;
    assert_eq!(send(&r, Request::get("/admin").body(Body::empty()).unwrap()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, Request::get("/admin").header("cookie", &stu).body(Body::empty()).unwrap()).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/admin/toggle_flag", &stu, &format!("csrf={sc}&key=x&enabled=true"))).await.0, StatusCode::FORBIDDEN);
    let (st, _, html) = send(&r, Request::get("/admin").header("cookie", &op).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK);
    assert!(html.contains("/admin/provision_user") && !html.contains("/admin/toggle_flag") && !html.contains("/admin/seed_synthetic"), "operator view");
    let (st, _, html) = send(&r, Request::get("/admin").header("cookie", &adm).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK);
    assert!(html.contains("/admin/toggle_flag") && html.contains("/admin/seed_synthetic") && html.contains("business.live_payment_transfers"));
    assert_eq!(send(&r, form("/admin/toggle_flag", &adm, "csrf=forged&key=school.grounded_ai_tutor&enabled=false")).await.0, StatusCode::FORBIDDEN);
    let (st, _, html) = send(&r, form("/admin/provision_user", &adm, &format!("csrf={ac}&email=t%40e.org&password=Password123%21&fullName=%3Cb%3ET%3C%2Fb%3E&role=teacher&countryCode=BJ"))).await;
    assert_eq!(st, StatusCode::OK, "{html}");
    assert!(html.contains("Utilisateur t@e.org créé") && html.contains("&lt;b&gt;T&lt;/b&gt;") && !html.contains("<b>T</b>"));
    let (st, _, html) = send(&r, form("/admin/toggle_flag", &adm, &format!("csrf={ac}&key=business.live_payment_transfers&enabled=true"))).await;
    if std::env::var("PAYMENT_PROVIDER").is_err() { assert_eq!(st, StatusCode::BAD_REQUEST); assert!(html.contains("LIVE_PAYMENT_PROVIDER_DISABLED")); }
    assert_eq!(send(&r, form("/admin/hack", &adm, &format!("csrf={ac}"))).await.0, StatusCode::NOT_FOUND);
}

#[test]
fn service_secret_rules() {
    let good = "s".repeat(32);
    assert_eq!(config::validate_service_secret(Some(&good), Some("production")).unwrap(), good);
    assert_eq!(config::validate_service_secret(None, Some("development")).unwrap(), config::DEV_ONLY_SERVICE_SECRET);
    assert!(config::DEV_ONLY_SERVICE_SECRET.len() >= 32);
    for (raw, env) in [(None, Some("production")), (Some(""), None), (Some("short"), Some("development")), (Some(&*"x".repeat(31)), Some("production")),
                       (Some(&*"changeme".repeat(5)), Some("production")), (None, Some("staging"))] {
        assert!(config::validate_service_secret(raw, env).is_err(), "{raw:?} {env:?}");
    }
    assert!(Config::test_default().service_secret.len() >= 32);
}
