//! Contributions utilisateurs (/contribute) contre PostgreSQL 16 + migrations opt-in 005 et 006.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, config::Config, crypto, db};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const M005: &str = include_str!("../../../db/migrations-ai/005_human_review.sql");
const M006: &str = include_str!("../../../db/migrations-ai/006_contributions.sql");

async fn fresh_db(with_ai: bool) -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    if with_ai { for _ in 0..2 { sqlx::raw_sql(M005).execute(&pool).await.unwrap(); sqlx::raw_sql(M006).execute(&pool).await.unwrap(); } }  // idempotentes
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

const BODY: &str = "Mi kudo ayiçié : bonjour en fon, texte de test.";
fn sub(c: &str, body: &str, extra: &str) -> String {
    format!("csrf={c}&kind=text&language=fon&body={}&attribution=Koami&consent=contrib-v1{extra}", urlencoding(body))
}
fn urlencoding(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }
async fn last_contrib(pool: &PgPool, uid: &str) -> (String, String) {
    sqlx::query_as("SELECT contribution_id, review_item_id FROM contributions WHERE contributor_id=$1 ORDER BY created_at DESC LIMIT 1").bind(uid).fetch_one(pool).await.unwrap()
}
async fn review(pool: &PgPool, item: &str, who: &str, d: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO ai_reviews(review_id,item_id,reviewer_id,decision) VALUES ($1,$2,$3,$4)").bind(crypto::create_id("rev")).bind(item).bind(who).bind(d).execute(pool).await.map(|_| ())
}
async fn points(pool: &PgPool, uid: &str) -> i64 {
    sqlx::query_scalar("SELECT COALESCE((SELECT points FROM contributor_reputation WHERE user_id=$1),0)::bigint").bind(uid).fetch_one(pool).await.unwrap()
}
async fn exportable(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar("SELECT contribution_id FROM contributions_exportable ORDER BY 1").fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn contribute_disabled_without_migrations() {
    let Some(pool) = fresh_db(false).await else { return };
    let r = router(&pool);
    let (ck, _, _) = user(&r, &pool, "u@e.org", "student").await;
    let (st, _, b, _) = send(&r, get("/contribute", &ck)).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE); assert!(b.contains("non activé"));
}

#[tokio::test]
async fn contribution_double_validation_and_export_gate() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, uid) = user(&r, &pool, "c@e.org", "student").await;
    let (_, _, r1) = user(&r, &pool, "r1@e.org", "reviewer").await;
    let (_, _, r2) = user(&r, &pool, "r2@e.org", "teacher").await;
    // RBAC / CSRF / CSP
    assert_eq!(send(&r, get("/contribute", "")).await.0, StatusCode::UNAUTHORIZED);
    let (st, _, b, csp) = send(&r, get("/contribute", &ck)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("CC BY 4.0")); assert!(!b.contains("<script"));
    assert!(csp.unwrap().contains("default-src"));
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub("forged", BODY, ""))).await.0, StatusCode::FORBIDDEN);
    // Consentement obligatoire, mineur sans accord parental, filtre de contenu
    let (st, _, b, _) = send(&r, form("/contribute/submit", &ck, &format!("csrf={c}&kind=text&language=fon&body={}&attribution=K", urlencoding(BODY)))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST); assert!(b.contains("consentement"), "{b}");
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, BODY, "&is_minor=yes"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, "ecris-moi a test@example.org stp", ""))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/contribute/submit", &ck, &format!("csrf={c}&kind=translation&language=fon&body={}&attribution=K&consent=contrib-v1", urlencoding(BODY)))).await.0, StatusCode::BAD_REQUEST);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM contributions").fetch_one(&pool).await.unwrap(); assert_eq!(n, 0);
    // Soumission valide puis doublon
    let (st, _, b, _) = send(&r, form("/contribute/submit", &ck, &sub(&c, BODY, ""))).await;
    assert_eq!(st, StatusCode::OK, "{b}"); assert!(b.contains("double validation"));
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, BODY, ""))).await.0, StatusCode::CONFLICT);
    let (cid, item) = last_contrib(&pool, &uid).await;
    let ev: i64 = sqlx::query_scalar("SELECT count(*) FROM contribution_consents WHERE contribution_id=$1 AND event='GIVEN'").bind(&cid).fetch_one(&pool).await.unwrap(); assert_eq!(ev, 1);
    // Auto-relecture interdite
    assert!(review(&pool, &item, &uid, "accept").await.unwrap_err().to_string().contains("SELF_REVIEW"));
    // Une seule validation : pas d'export
    review(&pool, &item, &r1, "accept").await.unwrap();
    assert!(exportable(&pool).await.is_empty());
    review(&pool, &item, &r2, "accept").await.unwrap();
    let st: String = sqlx::query_scalar("SELECT status FROM contributions WHERE contribution_id=$1").bind(&cid).fetch_one(&pool).await.unwrap();
    assert_eq!(st, "approved");
    assert_eq!(points(&pool, &uid).await, 10); assert_eq!(points(&pool, &r1).await, 1); assert_eq!(points(&pool, &r2).await, 1);
    assert_eq!(exportable(&pool).await, vec![cid.clone()]);
    // Item clos : nouvelle relecture refusée
    let (_, _, r3) = user(&r, &pool, "r3@e.org", "reviewer").await;
    assert!(review(&pool, &item, &r3, "reject").await.is_err());
    // Signalement ouvert : sort de l'export ; rejeté par l'admin : y revient
    let (rck, rc, rid) = user(&r, &pool, "rep@e.org", "student").await;
    assert_eq!(send(&r, form("/contribute/report", &ck, &format!("csrf={c}&contribution_id={cid}&reason=spam"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/contribute/report", &rck, &format!("csrf={rc}&contribution_id={cid}&reason=spam"))).await.0, StatusCode::OK);
    assert_eq!(send(&r, form("/contribute/report", &rck, &format!("csrf={rc}&contribution_id={cid}&reason=spam"))).await.0, StatusCode::CONFLICT);
    assert!(exportable(&pool).await.is_empty());
    let rep: String = sqlx::query_scalar("SELECT report_id FROM contribution_reports").fetch_one(&pool).await.unwrap();
    assert_eq!(send(&r, form("/contribute/resolve", &rck, &format!("csrf={rc}&report_id={rep}&decision=dismissed"))).await.0, StatusCode::FORBIDDEN);
    let (ack, ac, _) = user(&r, &pool, "adm@e.org", "admin").await;
    let (_, _, b, _) = send(&r, get("/contribute", &ack)).await; assert!(b.contains(&rep));
    assert_eq!(send(&r, form("/contribute/resolve", &ack, &format!("csrf={ac}&report_id={rep}&decision=dismissed"))).await.0, StatusCode::OK);
    assert_eq!(exportable(&pool).await, vec![cid.clone()]);
    // Retrait par le propriétaire seulement : exclu de l'export, données conservées
    assert_eq!(send(&r, form("/contribute/withdraw", &rck, &format!("csrf={rc}&contribution_id={cid}"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/contribute/withdraw", &ck, &format!("csrf={c}&contribution_id={cid}"))).await.0, StatusCode::OK);
    assert!(exportable(&pool).await.is_empty());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM contributions WHERE status='withdrawn'").fetch_one(&pool).await.unwrap(); assert_eq!(n, 1);
    let _ = rid;
    // Journaux en ajout seul
    assert!(sqlx::query("DELETE FROM reputation_events").execute(&pool).await.is_err());
    assert!(sqlx::query("UPDATE contribution_consents SET event='GIVEN'").execute(&pool).await.is_err());
    assert!(sqlx::query("UPDATE contribution_consent_texts SET body='x'").execute(&pool).await.is_err());
}

#[tokio::test]
async fn upheld_report_rejects_and_rejection_flow() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, uid) = user(&r, &pool, "c@e.org", "student").await;
    let (_, _, r1) = user(&r, &pool, "r1@e.org", "reviewer").await;
    let (_, _, r2) = user(&r, &pool, "r2@e.org", "reviewer").await;
    // Deux rejets : rejected, -2
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, "Premier texte de test en fon.", ""))).await.0, StatusCode::OK);
    let (c1, i1) = last_contrib(&pool, &uid).await;
    review(&pool, &i1, &r1, "reject").await.unwrap(); review(&pool, &i1, &r2, "reject").await.unwrap();
    let st: String = sqlx::query_scalar("SELECT status FROM contributions WHERE contribution_id=$1").bind(&c1).fetch_one(&pool).await.unwrap();
    assert_eq!(st, "rejected"); assert_eq!(points(&pool, &uid).await, -2);
    // Désaccord : reste pending
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, "Deuxieme texte de test en fon.", ""))).await.0, StatusCode::OK);
    let (c2, i2) = last_contrib(&pool, &uid).await;
    review(&pool, &i2, &r1, "accept").await.unwrap(); review(&pool, &i2, &r2, "reject").await.unwrap();
    let st: String = sqlx::query_scalar("SELECT status FROM contributions WHERE contribution_id=$1").bind(&c2).fetch_one(&pool).await.unwrap();
    assert_eq!(st, "pending");
    // Signalement retenu : rejected, -5 contributeur, +2 signaleur
    let (rck, rc, rid) = user(&r, &pool, "rep@e.org", "student").await;
    assert_eq!(send(&r, form("/contribute/report", &rck, &format!("csrf={rc}&contribution_id={c2}&reason=plagiarism"))).await.0, StatusCode::OK);
    let rep: String = sqlx::query_scalar("SELECT report_id FROM contribution_reports").fetch_one(&pool).await.unwrap();
    let (ack, ac, _) = user(&r, &pool, "adm@e.org", "admin").await;
    assert_eq!(send(&r, form("/contribute/resolve", &ack, &format!("csrf={ac}&report_id={rep}&decision=upheld"))).await.0, StatusCode::OK);
    assert_eq!(send(&r, form("/contribute/resolve", &ack, &format!("csrf={ac}&report_id={rep}&decision=upheld"))).await.0, StatusCode::NOT_FOUND);
    let st: String = sqlx::query_scalar("SELECT status FROM contributions WHERE contribution_id=$1").bind(&c2).fetch_one(&pool).await.unwrap();
    assert_eq!(st, "rejected"); assert_eq!(points(&pool, &uid).await, -7); assert_eq!(points(&pool, &rid).await, 2);
    // Rate limit horaire des soumissions
    let mut last = StatusCode::OK;
    for i in 0..12 { last = send(&r, form("/contribute/submit", &ck, &sub(&c, &format!("Texte numero {i} pour la limite."), ""))).await.0; }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

const M008: &str = include_str!("../../../db/migrations-ai/008_consent_v2.sql");

#[tokio::test]
async fn consent_v2_is_additive_and_shown() {
    let Some(pool) = fresh_db(true).await else { return };
    let v1_before: String = sqlx::query_scalar("SELECT body FROM contribution_consent_texts WHERE version='contrib-v1'").fetch_one(&pool).await.unwrap();
    for _ in 0..2 { sqlx::raw_sql(M008).execute(&pool).await.unwrap(); }  // idempotente
    let v1_after: String = sqlx::query_scalar("SELECT body FROM contribution_consent_texts WHERE version='contrib-v1'").fetch_one(&pool).await.unwrap();
    assert_eq!(v1_before, v1_after, "contrib-v1 ne doit jamais être modifié");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM contribution_consent_texts").fetch_one(&pool).await.unwrap(); assert_eq!(n, 2);
    // Les textes publiés restent immuables (trigger de 006).
    assert!(sqlx::query("UPDATE contribution_consent_texts SET body='x' WHERE version='contrib-v2'").execute(&pool).await.is_err());
    let r = router(&pool);
    let (ck, c, uid) = user(&r, &pool, "v2@e.org", "student").await;
    let (st, _, b, _) = send(&r, get("/contribute", &ck)).await;
    assert_eq!(st, StatusCode::OK);
    assert!(b.contains("contrib-v2")); assert!(b.contains("ne peut plus être retirée des modèles déjà entraînés"), "{b}");
    assert!(!b.contains("<script"));
    // L'ancien consentement n'est plus accepté pour une nouvelle soumission.
    assert_eq!(send(&r, form("/contribute/submit", &ck, &sub(&c, BODY, ""))).await.0, StatusCode::BAD_REQUEST);
    let v2 = format!("csrf={c}&kind=text&language=fon&body={}&attribution=Koami&consent=contrib-v2", urlencoding(BODY));
    let (st, _, b, _) = send(&r, form("/contribute/submit", &ck, &v2)).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    let (cid, _) = last_contrib(&pool, &uid).await;
    let cv: String = sqlx::query_scalar("SELECT consent_version FROM contributions WHERE contribution_id=$1").bind(&cid).fetch_one(&pool).await.unwrap();
    assert_eq!(cv, "contrib-v2");
}
