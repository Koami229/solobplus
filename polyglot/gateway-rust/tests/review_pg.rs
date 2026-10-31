//! Relecture humaine SOLOB AI (/review) contre PostgreSQL 16 + migration opt-in 005.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, config::Config, crypto, db};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const M005: &str = include_str!("../../../db/migrations-ai/005_human_review.sql");

async fn fresh_db(with_005: bool) -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    if with_005 { for _ in 0..2 { sqlx::raw_sql(M005).execute(&pool).await.unwrap(); } }  // idempotente
    Some(pool)
}
async fn send(r: &Router, req: Request<Body>) -> (StatusCode, Vec<String>, String, Option<String>) {
    let res = r.clone().oneshot(req).await.unwrap();
    let st = res.status();
    let csp = res.headers().get("content-security-policy").map(|v| v.to_str().unwrap().to_string());
    let ck = res.headers().get_all("set-cookie").iter().map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string()).collect();
    (st, ck, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap(), csp)
}
fn jpost(uri: &str, body: Value) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
}
fn get(uri: &str, ck: &str) -> Request<Body> { Request::get(uri).header("host", "app.test").header("cookie", ck).body(Body::empty()).unwrap() }
fn form(uri: &str, ck: &str, body: &str) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
}
async fn user(r: &Router, pool: &PgPool, email: &str, role: &str) -> (String, String, String) {
    let (st, _, b, _) = send(r, jpost("/api/auth", json!({"action":"register","email":email,"password":"Password123!","fullName":"Test U","role":"student"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{b}");
    sqlx::query("UPDATE users SET role=$2, pillar=CASE WHEN $2 IN ('admin','operator') THEN 'core' WHEN $2='reviewer' THEN 'business' ELSE pillar END WHERE email=$1").bind(email).bind(role).execute(pool).await.unwrap();
    let (_, ck, _, _) = send(r, jpost("/api/auth", json!({"action":"login","email":email,"password":"Password123!"}))).await;
    let s = ck.iter().find_map(|c| c.strip_prefix("solob_session=")).unwrap().to_string();
    let c = ck.iter().find_map(|c| c.strip_prefix("solob_csrf=")).unwrap().to_string();
    let id: String = sqlx::query_scalar("SELECT id FROM users WHERE email=$1").bind(email).fetch_one(pool).await.unwrap();
    (format!("solob_session={s}; solob_csrf={c}"), c, id)
}
fn router(pool: &PgPool) -> Router {
    app::router(app::AppState { pool: pool.clone(), cfg: Arc::new(Config::test_default()), http: reqwest::Client::new() })
}
async fn status(pool: &PgPool, id: &str) -> String {
    sqlx::query_scalar("SELECT status FROM ai_review_items WHERE item_id=$1").bind(id).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn review_disabled_without_migration_005() {
    let Some(pool) = fresh_db(false).await else { return };
    let r = router(&pool);
    let (ck, _, _) = user(&r, &pool, "rev@e.org", "reviewer").await;
    let (st, _, b, _) = send(&r, get("/review", &ck)).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert!(b.contains("non activé"));
}

#[tokio::test]
async fn double_blind_review_flow() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (adm, ac, _) = user(&r, &pool, "adm@e.org", "admin").await;
    let (r1, c1, id1) = user(&r, &pool, "r1@e.org", "reviewer").await;
    let (r2, c2, _) = user(&r, &pool, "r2@e.org", "teacher").await;
    let (stu, sc, _) = user(&r, &pool, "stu@e.org", "student").await;
    let (op, oc, _) = user(&r, &pool, "op@e.org", "operator").await;
    for (id, lang) in [("it_fon", "fon"), ("it_yo", "yo")] {
        sqlx::query("INSERT INTO ai_review_items(item_id,kind,language,source_ref,payload) VALUES ($1,'translation',$2,'t',$3)")
            .bind(id).bind(lang).bind(json!({"source_text":"Hello","translation":"<script>alert(1)</script>"})).execute(&pool).await.unwrap();
    }
    // RBAC: anonyme 401, étudiant/opérateur 403
    assert_eq!(send(&r, get("/review", "")).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, get("/review", &stu)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, get("/review", &op)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/review/submit", &stu, &format!("csrf={sc}&item_id=it_fon&decision=accept"))).await.0, StatusCode::FORBIDDEN);
    let _ = oc;
    // Rôle autorisé mais sans habilitation
    let (st, _, b, _) = send(&r, get("/review", &r1)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("pas d'habilitation"));
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=accept"))).await.0, StatusCode::FORBIDDEN);
    // Habilitation: admin seulement, CSRF obligatoire
    assert_eq!(send(&r, form("/review/grant", &r1, &format!("csrf={c1}&email=r1%40e.org&languages=fon"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/review/grant", &adm, "csrf=forged&email=r1%40e.org&languages=fon")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/review/grant", &adm, &format!("csrf={ac}&email=stu%40e.org&languages=fon"))).await.0, StatusCode::BAD_REQUEST);
    for e in ["r1", "r2"] { assert_eq!(send(&r, form("/review/grant", &adm, &format!("csrf={ac}&email={e}%40e.org&languages=fon"))).await.0, StatusCode::OK); }
    // File filtrée par langue, page sans JS et CSP stricte, contenu échappé
    let (st, _, b, csp) = send(&r, get("/review", &r1)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("it_fon") && !b.contains("it_yo"));
    assert!(!csp.unwrap().contains("unsafe-inline")); assert!(!b.contains("<script"));
    let (st, _, b, _) = send(&r, get("/review/item/it_fon", &r1)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("&lt;script&gt;") && !b.contains("<script"));
    assert_eq!(send(&r, get("/review/item/it_yo", &r1)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_yo&decision=accept"))).await.0, StatusCode::FORBIDDEN);
    // Validation des entrées
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=maybe"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=accept&score=9"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/review/submit", &r1, "csrf=forged&item_id=it_fon&decision=accept")).await.0, StatusCode::FORBIDDEN);
    // Double relecture: 1re → in_review, doublon → 409, 2e relecteur en désaccord → disputed
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=accept&score=4&comment=ok"))).await.0, StatusCode::OK);
    assert_eq!(status(&pool, "it_fon").await, "in_review");
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=reject"))).await.0, StatusCode::CONFLICT);
    let (_, _, b, _) = send(&r, get("/review/item/it_fon", &r2)).await;
    assert!(!b.contains("score=4") && !b.contains(">ok<") && b.contains("Enregistrer ma relecture"), "aveugle: pas de décision d'autrui");
    assert_eq!(send(&r, form("/review/submit", &r2, &format!("csrf={c2}&item_id=it_fon&decision=reject&comment=SECRET2"))).await.0, StatusCode::OK);
    assert_eq!(status(&pool, "it_fon").await, "disputed");
    let (_, _, b, _) = send(&r, get("/review/item/it_fon", &r1)).await;
    assert!(!b.contains("SECRET2"));
    assert_eq!(send(&r, form("/review/submit", &r1, &format!("csrf={c1}&item_id=it_fon&decision=accept"))).await.0, StatusCode::CONFLICT);
    // Accord affiché à l'admin (kappa défini: 1 item double-relu)
    let (_, _, b, _) = send(&r, get("/review", &adm)).await;
    assert!(b.contains("Accord inter-annotateurs"));
    // Audit
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action='AI_REVIEW_SUBMIT' AND status='SUCCESS'").fetch_one(&pool).await.unwrap();
    assert_eq!(n, 2);
    let d: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action='AI_REVIEWER_GRANT' AND status='DENIED'").fetch_one(&pool).await.unwrap();
    assert_eq!(d, 1);
    let a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_review_audit").fetch_one(&pool).await.unwrap();
    assert_eq!(a, 4, "2 habilitations + 2 relectures");
    assert!(sqlx::query("DELETE FROM ai_review_audit").execute(&pool).await.is_err(), "journal en ajout seul");
    let _ = id1;
}

#[tokio::test]
async fn review_rate_limited() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (adm, ac, _) = user(&r, &pool, "adm@e.org", "admin").await;
    let mut last = StatusCode::OK;
    for _ in 0..61 { last = send(&r, form("/review/submit", &adm, &format!("csrf={ac}&item_id=none&decision=accept"))).await.0; }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}
