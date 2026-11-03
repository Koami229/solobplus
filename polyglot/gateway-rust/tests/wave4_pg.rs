//! Vague 4 : écran annotatrice T05 (SSR) et migration 011 (RLS équipe sur annotation_audio_sources).
use axum::{body::Body, http::{Request, StatusCode}, Router};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const AI: &[&str] = &[
    include_str!("../../../db/migrations-ai/004_sakc.sql"), include_str!("../../../db/migrations-ai/005_human_review.sql"),
    include_str!("../../../db/migrations-ai/006_contributions.sql"), include_str!("../../../db/migrations-ai/007_training_usage.sql"),
    include_str!("../../../db/migrations-ai/008_consent_v2.sql"), include_str!("../../../db/migrations-ai/009_launch_must.sql"),
    include_str!("../../../db/migrations-ai/010_quotes_school_annotation.sql"), include_str!("../../../db/migrations-ai/011_annotation_sources_rls.sql"),
];

async fn fresh_db(n: usize) -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    { for _ in 0..2 { for m in &AI[..n] { sqlx::raw_sql(m).execute(&pool).await.unwrap(); } } } // idempotentes (start.sh les rejoue)
    Some(pool)
}
async fn send(r: &Router, req: Request<Body>) -> (StatusCode, Vec<String>, String) {
    let res = r.clone().oneshot(req).await.unwrap();
    let st = res.status();
    let ck = res.headers().get_all("set-cookie").iter().map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string()).collect();
    (st, ck, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}
fn jpost(uri: &str, body: Value) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
}
fn get(uri: &str, ck: &str) -> Request<Body> { Request::get(uri).header("host", "app.test").header("cookie", ck).body(Body::empty()).unwrap() }
fn form(uri: &str, ck: &str, body: &str) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
}
fn enc(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }
async fn login(r: &Router, email: &str) -> (StatusCode, String, String) {
    let (st, ck, _) = send(r, jpost("/api/auth", json!({"action":"login","email":email,"password":"Password123!"}))).await;
    let s = ck.iter().find_map(|c| c.strip_prefix("solob_session=")).unwrap_or("").to_string();
    let c = ck.iter().find_map(|c| c.strip_prefix("solob_csrf=")).unwrap_or("").to_string();
    (st, format!("solob_session={s}; solob_csrf={c}"), c)
}
async fn user(r: &Router, pool: &PgPool, email: &str, role: &str) -> (String, String, String) {
    let (st, _, b) = send(r, jpost("/api/auth", json!({"action":"register","email":email,"password":"Password123!","fullName":format!("Talent {email}"),"role":"student"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{b}");
    sqlx::query("UPDATE users SET role=$2, pillar=CASE WHEN $2 IN ('admin','operator') THEN 'core' WHEN $2 IN ('reviewer','contributor','org_client') THEN 'business' ELSE pillar END WHERE email=$1").bind(email).bind(role).execute(pool).await.unwrap();
    let (_, ck, c) = login(r, email).await;
    let id: String = sqlx::query_scalar("SELECT id FROM users WHERE email=$1").bind(email).fetch_one(pool).await.unwrap();
    (ck, c, id)
}
fn router(pool: &PgPool) -> Router { app::router(app::AppState { pool: pool.clone(), cfg: Arc::new(Config::test_default()), http: reqwest::Client::new() }) }
async fn audit_count(pool: &PgPool, action: &str) -> i64 { sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action=$1").bind(action).fetch_one(pool).await.unwrap() }
use solob_gateway::{app, config::Config, crypto, db};

async fn count_as_app(pool: &PgPool, uid: &str, staff: bool, sql: &str) -> Result<i64, String> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.user_id',$1,true), set_config('app.staff',$2,true)").bind(uid).bind(if staff { "on" } else { "off" }).execute(&mut *tx).await.unwrap();
    sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await.unwrap();
    sqlx::query_scalar(sql).fetch_one(&mut *tx).await.map_err(|e| e.to_string())
}
async fn task_status(pool: &PgPool, id: &str) -> String { sqlx::query_scalar("SELECT status FROM annotation_tasks WHERE task_id=$1").bind(id).fetch_one(pool).await.unwrap() }

#[tokio::test]
async fn m011_sources_staff_only_rls_and_catalog_view() {
    let Some(pool) = fresh_db(AI.len()).await else { return };
    sqlx::query("INSERT INTO annotation_audio_sources VALUES ('s1','Conte','fon','CC-BY-4.0','contrat-2026-01','consent-spk-7',now())").execute(&pool).await.unwrap();
    let rls: bool = sqlx::query_scalar("SELECT relrowsecurity FROM pg_class WHERE relname='annotation_audio_sources'").fetch_one(&pool).await.unwrap();
    assert!(rls);
    assert_eq!(count_as_app(&pool, "u1", false, "SELECT COUNT(*) FROM annotation_audio_sources").await.unwrap(), 0);
    assert_eq!(count_as_app(&pool, "u1", true, "SELECT COUNT(*) FROM annotation_audio_sources").await.unwrap(), 1);
    // vue sans preuves ni consentement : lisible par l'annotatrice
    assert_eq!(count_as_app(&pool, "u1", false, "SELECT COUNT(*) FROM annotation_sources_catalog").await.unwrap(), 1);
    let cols: Vec<String> = sqlx::query_scalar("SELECT column_name::text FROM information_schema.columns WHERE table_name='annotation_sources_catalog' ORDER BY 1").fetch_all(&pool).await.unwrap();
    assert_eq!(cols, vec!["language", "license", "source_id", "title"]);
    // insertion réservée à l'équipe
    let ins = "INSERT INTO annotation_audio_sources VALUES ('s2','X','fon','CC0','p','c',now()) RETURNING 1::bigint";
    assert!(count_as_app(&pool, "u1", false, ins).await.unwrap_err().contains("row-level security"));
}

#[tokio::test]
async fn annotation_disabled_without_011() {
    let Some(pool) = fresh_db(AI.len() - 1).await else { return };
    let r = router(&pool);
    let (ck, _, _) = user(&r, &pool, "a@e.org", "contributor").await;
    assert_eq!(send(&r, get("/annotation", &ck)).await.0, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn t05_annotator_screen_full_flow() {
    let Some(pool) = fresh_db(AI.len()).await else { return };
    let r = router(&pool);
    let (cka, ca, aid) = user(&r, &pool, "annot@e.org", "contributor").await;
    let (ckb, _, _) = user(&r, &pool, "annot2@e.org", "contributor").await;
    let (ckv, cv, vid) = user(&r, &pool, "rev@e.org", "reviewer").await;
    let (ckw, cw, _) = user(&r, &pool, "rev2@e.org", "reviewer").await;
    let (cks, _, _) = user(&r, &pool, "eleve@e.org", "student").await;
    assert_eq!(send(&r, Request::get("/annotation").header("host", "app.test").body(Body::empty()).unwrap()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, get("/annotation", &cks)).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, get("/talent", &cka)).await; assert_eq!(st, StatusCode::OK); assert!(b.contains("href=\"/annotation\""));
    let src = |rights: &str, consent: &str, date: &str| format!("title=Conte+du+soir&language=fon&license=CC-BY-4.0&rights_proof={rights}&speaker_consent_ref={consent}&consent_date={date}");
    // l'annotatrice ne peut pas enregistrer de source
    assert_eq!(send(&r, form("/annotation/source", &cka, &format!("csrf={ca}&{}", src("contrat-01", "consent-7", "2026-10-01")))).await.0, StatusCode::FORBIDDEN);
    // CSRF, droits et consentement requis
    assert_eq!(send(&r, form("/annotation/source", &ckv, &format!("csrf=bad&{}", src("contrat-01", "consent-7", "2026-10-01")))).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, form("/annotation/source", &ckv, &format!("csrf={cv}&{}", src("", "consent-7", "2026-10-01")))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST); assert!(b.contains("Preuve de droits requise"));
    assert_eq!(send(&r, form("/annotation/source", &ckv, &format!("csrf={cv}&{}", src("contrat-01", "", "2026-10-01")))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/annotation/source", &ckv, &format!("csrf={cv}&{}", src("contrat-01", "consent-7", "")))).await.0, StatusCode::BAD_REQUEST);
    let (st, _, b) = send(&r, form("/annotation/source", &ckv, &format!("csrf={cv}&{}", src("contrat-SECRET-01", "consent-spk-7", "2026-10-01")))).await;
    assert_eq!(st, StatusCode::OK, "{b}"); assert!(b.contains("contrat-SECRET-01"));
    let sid: String = sqlx::query_scalar("SELECT source_id FROM annotation_audio_sources").fetch_one(&pool).await.unwrap();
    assert_eq!(send(&r, form("/annotation/task", &ckv, &format!("csrf={cv}&source_id={sid}&start_ms=500&end_ms=100"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/annotation/task", &ckv, &format!("csrf={cv}&source_id=nope&start_ms=0&end_ms=15000"))).await.0, StatusCode::BAD_REQUEST);
    for _ in 0..2 { assert_eq!(send(&r, form("/annotation/task", &ckv, &format!("csrf={cv}&source_id={sid}&start_ms=0&end_ms=15000"))).await.0, StatusCode::OK); }
    let tids: Vec<String> = sqlx::query_scalar("SELECT task_id FROM annotation_tasks ORDER BY task_id").fetch_all(&pool).await.unwrap();
    let (t1, t2) = (tids[0].clone(), tids[1].clone());
    // l'annotatrice voit titre/langue/licence, jamais la preuve de droits ni le consentement
    let (st, _, b) = send(&r, get("/annotation", &cka)).await;
    assert_eq!(st, StatusCode::OK);
    assert!(b.contains("Conte du soir") && b.contains("CC-BY-4.0") && b.contains("Prendre cette tâche") && !b.contains("contrat-SECRET-01") && !b.contains("consent-spk-7"));
    // prise de tâche ; une seconde prise échoue
    assert_eq!(send(&r, form("/annotation/claim", &cka, &format!("csrf={ca}&task_id={t1}"))).await.0, StatusCode::OK);
    let (_, ckb_csrf) = (ckb.clone(), ckb.split("solob_csrf=").nth(1).unwrap().to_string());
    assert_eq!(send(&r, form("/annotation/claim", &ckb, &format!("csrf={ckb_csrf}&task_id={t1}"))).await.0, StatusCode::CONFLICT);
    // l'autre annotatrice ne voit pas la tâche prise
    let (_, _, b) = send(&r, get("/annotation", &ckb)).await; assert_eq!(b.matches("Prendre cette tâche").count(), 1);
    // soumission : transcription ET traduction
    assert_eq!(send(&r, form("/annotation/submit", &cka, &format!("csrf={ca}&task_id={t1}&transcription={}&translation_fr=", enc("Mi kú dé")))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/annotation/submit", &ckb, &format!("csrf={ckb_csrf}&task_id={t1}&transcription=x&translation_fr=y"))).await.0, StatusCode::CONFLICT);
    let (st, _, b) = send(&r, form("/annotation/submit", &cka, &format!("csrf={ca}&task_id={t1}&transcription={}&translation_fr={}", enc("Mi kú dé"), enc("Bonsoir")))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("À relire") && b.contains("second relecteur"));
    assert_eq!(task_status(&pool, &t1).await, "to_review");
    // l'annotatrice ne peut ni relire ni livrer
    assert_eq!(send(&r, form("/annotation/review", &cka, &format!("csrf={ca}&task_id={t1}&decision=validated"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/annotation/deliver", &cka, &format!("csrf={ca}&task_id={t1}"))).await.0, StatusCode::FORBIDDEN);
    // livraison avant validation refusée
    assert_eq!(send(&r, form("/annotation/deliver", &ckv, &format!("csrf={cv}&task_id={t1}"))).await.0, StatusCode::CONFLICT);
    // refus sans commentaire refusé ; refus avec commentaire renvoie à l'auteur
    assert_eq!(send(&r, form("/annotation/review", &ckv, &format!("csrf={cv}&task_id={t1}&decision=rejected&comment="))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/annotation/review", &ckv, &format!("csrf={cv}&task_id={t1}&decision=rejected&comment={}", enc("Ton manquant sur kú")))).await.0, StatusCode::OK);
    let (_, _, b) = send(&r, get("/annotation", &cka)).await; assert!(b.contains("Ton manquant sur kú") && b.contains("Refusée"));
    assert_eq!(send(&r, form("/annotation/submit", &cka, &format!("csrf={ca}&task_id={t1}&transcription={}&translation_fr={}", enc("Mi kù dé"), enc("Bonsoir")))).await.0, StatusCode::OK);
    assert_eq!(send(&r, form("/annotation/review", &ckv, &format!("csrf={cv}&task_id={t1}&decision=validated"))).await.0, StatusCode::OK);
    let (st, _, b) = send(&r, form("/annotation/deliver", &ckv, &format!("csrf={cv}&task_id={t1}"))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("livrée"));
    assert_eq!(task_status(&pool, &t1).await, "delivered");
    let rv: String = sqlx::query_scalar("SELECT reviewer_id FROM annotation_tasks WHERE task_id=$1").bind(&t1).fetch_one(&pool).await.unwrap();
    assert!(rv == vid && rv != aid);
    // un relecteur ne relit pas sa propre tâche (règle en base)
    assert_eq!(send(&r, form("/annotation/claim", &ckw, &format!("csrf={cw}&task_id={t2}"))).await.0, StatusCode::OK);
    assert_eq!(send(&r, form("/annotation/submit", &ckw, &format!("csrf={cw}&task_id={t2}&transcription=a&translation_fr=b"))).await.0, StatusCode::OK);
    let (_, _, b) = send(&r, get("/annotation", &ckw)).await; assert!(!b.contains("name=\"decision\""));
    let (st, _, b) = send(&r, form("/annotation/review", &ckw, &format!("csrf={cw}&task_id={t2}&decision=validated"))).await;
    assert_eq!(st, StatusCode::FORBIDDEN); assert!(b.contains("Auto-revue interdite"));
    assert_eq!(task_status(&pool, &t2).await, "to_review");
    for a in ["ANNOTATION_SOURCE_CREATED", "ANNOTATION_TASK_SUBMITTED", "ANNOTATION_TASK_REVIEWED", "ANNOTATION_TASK_DELIVERED"] { assert!(audit_count(&pool, a).await >= 1, "{a}"); }
    assert!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_events WHERE action='ANNOTATION_STAFF_ACTION' AND status='DENIED'").fetch_one(&pool).await.unwrap() >= 1);
}
