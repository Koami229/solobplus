//! Integration tests against a real PostgreSQL (TEST_DATABASE_ADMIN_URL, e.g. postgres://solob@127.0.0.1:55432/postgres).
//! Each test creates its own throwaway database. Skipped (with a message) when the variable is unset.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, auth, config::Config, crypto, db, rate_limit};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

async fn fresh_db() -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let url = format!("{}/{}", admin.rsplit_once('/').unwrap().0, name);
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(20).connect(&url).await.unwrap();
    db::migrate(&pool).await.unwrap();
    Some(pool)
}

fn appr(pool: PgPool, cfg: Config) -> Router {
    app::router(app::AppState { pool, cfg: Arc::new(cfg), http: reqwest::Client::new() })
}

async fn call(r: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let res = r.clone().oneshot(req).await.unwrap();
    let (st, hm) = (res.status(), res.headers().clone());
    let b = res.into_body().collect().await.unwrap().to_bytes();
    (st, hm, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn post_json(uri: &str, body: Value, extra: &[(&str, &str)]) -> Request<Body> {
    let mut b = Request::post(uri).header("host", "app.test").header("content-type", "application/json");
    for (k, v) in extra { b = b.header(*k, *v); }
    b.body(Body::from(body.to_string())).unwrap()
}

fn cookie_pair(hm: &axum::http::HeaderMap) -> (String, String) {
    let mut s = String::new(); let mut c = String::new();
    for v in hm.get_all("set-cookie") {
        let v = v.to_str().unwrap();
        let kv = v.split(';').next().unwrap();
        if kv.starts_with("solob_session=") { s = kv["solob_session=".len()..].into(); assert!(v.contains("HttpOnly")); assert!(v.contains("SameSite=Lax")); }
        if kv.starts_with("solob_csrf=") { c = kv["solob_csrf=".len()..].into(); assert!(!v.contains("HttpOnly")); }
    }
    (s, c)
}

#[tokio::test]
async fn migrations_are_idempotent() {
    let Some(pool) = fresh_db().await else { return };
    assert!(db::migrate(&pool).await.unwrap().is_empty());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 3);
}

#[tokio::test]
async fn register_login_me_logout_flow_with_csrf() {
    let Some(pool) = fresh_db().await else { return };
    let r = appr(pool.clone(), Config::test_default());
    let reg = json!({"action":"register","email":"Ama@Example.org","password":"Password123!","fullName":"Ama K","role":"student"});
    let (st, hm, body) = call(&r, post_json("/api/auth", reg.clone(), &[("origin", "http://app.test")])).await;
    assert_eq!(st, StatusCode::CREATED, "{body}");
    assert_eq!(body["user"]["email"], "ama@example.org");
    assert_eq!(body["user"]["pillar"], "school");
    assert!(hm.get("content-security-policy").is_some());
    let (sess, csrf) = cookie_pair(&hm);
    assert_eq!(csrf, body["csrfToken"]);
    // duplicate
    let (st, _, b) = call(&r, post_json("/api/auth", reg, &[])).await;
    assert_eq!(st, StatusCode::CONFLICT); assert_eq!(b["error"]["code"], "EMAIL_ALREADY_EXISTS");
    // me
    let ck = format!("solob_session={sess}; solob_csrf={csrf}");
    let (st, _, b) = call(&r, Request::get("/api/auth").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK); assert_eq!(b["user"]["role"], "student");
    // logout without CSRF header is refused
    let (st, _, b) = call(&r, post_json("/api/auth", json!({"action":"logout"}), &[("cookie", &ck)])).await;
    assert_eq!(st, StatusCode::FORBIDDEN); assert_eq!(b["error"]["code"], "CSRF_VALIDATION_FAILED");
    // with mismatching header refused
    let (st, _, _) = call(&r, post_json("/api/auth", json!({"action":"logout"}), &[("cookie", &ck), ("x-solob-csrf", "bad")])).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _, b) = call(&r, post_json("/api/auth", json!({"action":"logout"}), &[("cookie", &ck), ("x-solob-csrf", &csrf)])).await;
    assert_eq!(st, StatusCode::OK); assert_eq!(b["revoked"], true);
    let (_, _, b) = call(&r, Request::get("/api/auth").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert!(b["user"].is_null(), "revoked session must not authenticate");
    // login
    let (st, hm, _) = call(&r, post_json("/api/auth", json!({"action":"login","email":"ama@example.org","password":"Password123!"}), &[])).await;
    assert_eq!(st, StatusCode::OK); assert!(!cookie_pair(&hm).0.is_empty());
    let (st, _, b) = call(&r, post_json("/api/auth", json!({"action":"login","email":"ama@example.org","password":"wrong-pass"}), &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED); assert_eq!(b["error"]["code"], "INVALID_CREDENTIALS");
}

#[tokio::test]
async fn cross_origin_and_privileged_registration_refused() {
    let Some(pool) = fresh_db().await else { return };
    let r = appr(pool.clone(), Config::test_default());
    let (st, _, b) = call(&r, post_json("/api/auth", json!({"action":"register","email":"x@e.org","password":"Password123!","fullName":"X Y","role":"student"}), &[("origin", "https://evil.example")])).await;
    assert_eq!(st, StatusCode::FORBIDDEN); assert_eq!(b["error"]["code"], "CSRF_VALIDATION_FAILED");
    for role in ["admin", "operator", "reviewer", "teacher"] {
        let (st, _, b) = call(&r, post_json("/api/auth", json!({"action":"register","email":format!("{role}@e.org"),"password":"Password123!","fullName":"X Y","role":role}), &[])).await;
        assert_eq!(st, StatusCode::FORBIDDEN); assert_eq!(b["error"]["code"], "PRIVILEGED_ROLE_FORBIDDEN");
    }
    let denied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action='USER_REGISTER_PRIVILEGED_ROLE_DENIED'").fetch_one(&pool).await.unwrap();
    assert_eq!(denied, 4);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn rbac_on_proxied_pillars_and_admin() {
    let Some(pool) = fresh_db().await else { return };
    let r = appr(pool.clone(), Config::test_default());
    let (_, hm, _) = call(&r, post_json("/api/auth", json!({"action":"register","email":"c@e.org","password":"Password123!","fullName":"Org C","role":"org_client"}), &[])).await;
    let (s, c) = cookie_pair(&hm);
    let ck = format!("solob_session={s}; solob_csrf={c}");
    let (st, _, b) = call(&r, Request::get("/api/school/health").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN); assert_eq!(b["error"]["code"], "FORBIDDEN_ROLE");
    let (st, _, _) = call(&r, Request::get("/api/school/health").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    // allowed role reaches the (unavailable in this test) upstream => 502, proving the guard passed.
    let (st, _, b) = call(&r, Request::get("/api/business/health").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY, "{b}");
    let (st, _, _) = call(&r, Request::get("/api/admin/overview").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _, _) = call(&r, Request::get("/admin").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rate_limit_is_atomic_under_concurrency() {
    let Some(pool) = fresh_db().await else { return };
    let mut hs = vec![];
    for _ in 0..50 {
        let p = pool.clone();
        hs.push(tokio::spawn(async move { rate_limit::check(&p, "it:concurrent", 10, 60_000).await.unwrap().allowed }));
    }
    let mut ok = 0;
    for h in hs { if h.await.unwrap() { ok += 1; } }
    assert_eq!(ok, 10);
    // window reset
    let d = rate_limit::check(&pool, "it:short", 1, 200).await.unwrap(); assert!(d.allowed);
    assert!(!rate_limit::check(&pool, "it:short", 1, 200).await.unwrap().allowed);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(rate_limit::check(&pool, "it:short", 1, 200).await.unwrap().allowed);
}

#[tokio::test]
async fn rate_limit_fails_closed_when_store_unavailable() {
    let Some(pool) = fresh_db().await else { return };
    sqlx::query("DROP TABLE rate_limit_buckets").execute(&pool).await.unwrap();
    let e = rate_limit::check(&pool, "k", 1, 1000).await.unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (503, "RATE_LIMIT_UNAVAILABLE"));
}

#[tokio::test]
async fn login_rate_limited_per_email() {
    let Some(pool) = fresh_db().await else { return };
    let r = appr(pool, Config::test_default());
    let mut last = StatusCode::OK;
    for i in 0..11 {
        let (st, _, _) = call(&r, post_json("/api/auth", json!({"action":"login","email":"nobody@e.org","password":"x"}),
            &[("user-agent", &format!("ua{i}"))])).await;
        last = st;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn admin_bootstrap_is_single_under_concurrency() {
    let Some(pool) = fresh_db().await else { return };
    let mut hs = vec![];
    for i in 0..8 {
        let p = pool.clone();
        hs.push(tokio::spawn(async move { auth::bootstrap_initial_admin(&p, &format!("admin{i}@solob.example"), "Very-Long-Passw0rd!", "Admin", "BJ").await }));
    }
    let mut ok = 0; let mut conflicts = 0;
    for h in hs { match h.await.unwrap() { Ok(_) => ok += 1, Err(e) => { assert_eq!(e.code, "ADMIN_ALREADY_BOOTSTRAPPED"); conflicts += 1 } } }
    assert_eq!((ok, conflicts), (1, 7));
    let admins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role='admin'").fetch_one(&pool).await.unwrap();
    assert_eq!(admins, 1);
    let e = auth::bootstrap_initial_admin(&pool, "a@b.org", "short", "Admin", "BJ").await.unwrap_err();
    assert_eq!(e.code, "WEAK_BOOTSTRAP_ADMIN_PASSWORD");
}

#[tokio::test]
async fn admin_can_read_overview_and_node_hash_users_can_login() {
    let Some(pool) = fresh_db().await else { return };
    auth::bootstrap_initial_admin(&pool, "root@solob.example", "Very-Long-Passw0rd!", "Root", "BJ").await.unwrap();
    // A user whose hash was produced by the TypeScript (Node) implementation must still log in.
    let node_hash = include_str!("fixtures/node_scrypt_hash.txt").trim();
    sqlx::query("INSERT INTO users (id,email,password_hash,full_name,role,pillar) VALUES ('usr_legacy','legacy@e.org',$1,'Legacy','student','school')")
        .bind(node_hash).execute(&pool).await.unwrap();
    let r = appr(pool, Config::test_default());
    let (st, _, _) = call(&r, post_json("/api/auth", json!({"action":"login","email":"legacy@e.org","password":"Password123!"}), &[])).await;
    assert_eq!(st, StatusCode::OK);
    let (_, hm, _) = call(&r, post_json("/api/auth", json!({"action":"login","email":"root@solob.example","password":"Very-Long-Passw0rd!"}), &[])).await;
    let (s, _) = cookie_pair(&hm);
    let (st, _, b) = call(&r, Request::get("/api/admin/overview").header("cookie", format!("solob_session={s}")).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK); assert_eq!(b["users"], 2);
}

#[tokio::test]
async fn ui_pages_render_with_strict_headers() {
    let Some(pool) = fresh_db().await else { return };
    let r = appr(pool, Config::test_default());
    for p in ["/", "/login"] {
        let res = r.clone().oneshot(Request::get(p).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["x-frame-options"], "DENY");
        assert_eq!(res.headers()["x-content-type-options"], "nosniff");
        assert!(!res.headers()["content-security-policy"].to_str().unwrap().contains("unsafe-inline"));
    }
    let res = r.clone().oneshot(Request::get("/school").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
