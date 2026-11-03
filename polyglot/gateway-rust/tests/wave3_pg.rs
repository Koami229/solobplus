//! Vague 3 (migration 010) : devis Business sur demande (RLS, statut réservé à l'équipe), S06 validation langues, T05 annotation audio, A01 refus SAKC.
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
    include_str!("../../../db/migrations-ai/010_quotes_school_annotation.sql"),
];

async fn fresh_db(with_009: bool) -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    if with_009 { for _ in 0..2 { for m in AI { sqlx::raw_sql(m).execute(&pool).await.unwrap(); } } } // idempotentes (start.sh les rejoue)
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

fn deadline() -> String { ((Utc::now() + Duration::days(20)).date_naive()).format("%Y-%m-%d").to_string() }

#[tokio::test]
async fn quotes_disabled_without_010() {
    let Some(pool) = fresh_db(false).await else { return };
    let r = router(&pool);
    let (ck, _, _) = user(&r, &pool, "c@e.org", "org_client").await;
    let (st, _, _) = send(&r, get("/enterprise/quotes", &ck)).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn business_quote_request_on_demand_rls_and_staff_status() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, _) = user(&r, &pool, "client@e.org", "org_client").await;
    let (ck2, c2, _) = user(&r, &pool, "client2@e.org", "org_client").await;
    let (cks, _, _) = user(&r, &pool, "eleve@e.org", "student").await;
    let (ckr, cr, _) = user(&r, &pool, "rev@e.org", "reviewer").await;
    // non connecté / mauvais rôle
    assert_eq!(send(&r, Request::get("/enterprise/quotes").header("host", "app.test").body(Body::empty()).unwrap()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&r, get("/enterprise/quotes", &cks)).await.0, StatusCode::FORBIDDEN);
    // page : sur devis, aucune grille de prix
    let (st, _, b) = send(&r, get("/enterprise/quotes", &ck)).await;
    assert_eq!(st, StatusCode::OK);
    assert!(b.contains("sur devis") && b.contains("Demander un devis") && !b.contains("FCFA") && !b.contains("€"));
    let need = enc("Annotation de 40 heures d'audio en fon");
    // CSRF requis
    assert_eq!(send(&r, form("/enterprise/quotes/request", &ck, &format!("csrf=bad&need={need}&volume=40h&languages=fon&deadline={}", deadline()))).await.0, StatusCode::FORBIDDEN);
    // validation
    assert_eq!(send(&r, form("/enterprise/quotes/request", &ck, &format!("csrf={c}&need=court&volume=40h&languages=fon&deadline={}", deadline()))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/enterprise/quotes/request", &ck, &format!("csrf={c}&need={need}&volume=40h&languages=fon&deadline=2020-01-01"))).await.0, StatusCode::BAD_REQUEST);
    let before = audit_count(&pool, "QUOTE_REQUEST_CREATED").await;
    let (st, _, b) = send(&r, form("/enterprise/quotes/request", &ck, &format!("csrf={c}&need={need}&volume=40h&languages=fon%2C+bariba&deadline={}", deadline()))).await;
    assert_eq!(st, StatusCode::OK, "{b}");
    assert!(b.contains("Demande de devis enregistrée") && b.contains("Reçue") && b.contains("fon, bariba"));
    assert_eq!(audit_count(&pool, "QUOTE_REQUEST_CREATED").await, before + 1);
    // RLS : l'autre entreprise ne voit rien
    let (_, _, b) = send(&r, get("/enterprise/quotes", &ck2)).await;
    assert!(b.contains("Aucune demande de devis") && !b.contains("bariba"));
    let qid: String = sqlx::query_scalar("SELECT quote_id FROM business_quote_requests").fetch_one(&pool).await.unwrap();
    // le client ne peut pas changer le statut
    assert_eq!(send(&r, form("/enterprise/quotes/status", &ck, &format!("csrf={c}&quote_id={qid}&status=accepted"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/enterprise/quotes/status", &ck2, &format!("csrf={c2}&quote_id={qid}&status=accepted"))).await.0, StatusCode::FORBIDDEN);
    // l'équipe voit tout et met à jour le statut
    let (_, _, b) = send(&r, get("/enterprise/quotes", &ckr)).await;
    assert!(b.contains("Demandes de devis des entreprises") && b.contains("bariba"));
    assert_eq!(send(&r, form("/enterprise/quotes/status", &ckr, &format!("csrf={cr}&quote_id={qid}&status=bogus"))).await.0, StatusCode::BAD_REQUEST);
    let (st, _, _) = send(&r, form("/enterprise/quotes/status", &ckr, &format!("csrf={cr}&quote_id={qid}&status=quote_sent&staff_note=Devis+envoy%C3%A9+par+email"))).await;
    assert_eq!(st, StatusCode::OK);
    let (_, _, b) = send(&r, get("/enterprise/quotes", &ck)).await;
    assert!(b.contains("Devis envoyé") && b.contains("Devis envoyé par email"));
    // garde SQL : même en SQL direct sous solob_app sans app.staff, le client ne peut pas changer le statut
    let cid: String = sqlx::query_scalar("SELECT id FROM users WHERE email='client@e.org'").fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.user_id',$1,true), set_config('app.staff','off',true)").bind(&cid).execute(&mut *tx).await.unwrap();
    sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await.unwrap();
    let e = sqlx::query("UPDATE business_quote_requests SET status='accepted'").execute(&mut *tx).await.unwrap_err();
    assert!(e.to_string().contains("QUOTE_STATUS"));
}

async fn as_app(pool: &PgPool, uid: &str, staff: bool, sql: &str) -> Result<u64, String> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.user_id',$1,true), set_config('app.staff',$2,true)").bind(uid).bind(if staff { "on" } else { "off" }).execute(&mut *tx).await.unwrap();
    sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await.unwrap();
    let r = sqlx::query(sql).execute(&mut *tx).await.map(|x| x.rows_affected()).map_err(|e| e.to_string());
    if r.is_ok() { tx.commit().await.unwrap(); }
    r
}

#[tokio::test]
async fn s06_language_content_needs_distinct_validator_and_hidden_until_validated() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (_, _, a) = user(&r, &pool, "auteur@e.org", "contributor").await;
    let (_, _, v) = user(&r, &pool, "spec@e.org", "reviewer").await;
    let (_, _, s) = user(&r, &pool, "eleve@e.org", "student").await;
    as_app(&pool, &a, false, &format!("INSERT INTO school_language_contents(content_id,author_id,language,title,body) VALUES ('c1','{a}','fon','Salutations','Contenu de cours en fon')")).await.unwrap();
    let seen = |p: PgPool, u: String| async move { let mut tx = p.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.user_id',$1,true), set_config('app.staff','off',true)").bind(&u).execute(&mut *tx).await.unwrap();
        sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await.unwrap();
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM school_language_contents").fetch_one(&mut *tx).await.unwrap(); n };
    assert_eq!(seen(pool.clone(), s.clone()).await, 0, "élève : invisible tant que non validé");
    // auto-validation interdite
    let e = as_app(&pool, &a, true, &format!("UPDATE school_language_contents SET status='validated', validator_id='{a}', validated_at=now()")).await.unwrap_err();
    assert!(e.contains("SELF_REVIEW"));
    // rejet sans commentaire interdit
    assert!(as_app(&pool, &v, true, &format!("UPDATE school_language_contents SET status='rejected', validator_id='{v}'")).await.is_err());
    as_app(&pool, &v, true, &format!("UPDATE school_language_contents SET status='validated', validator_id='{v}', validated_at=now()")).await.unwrap();
    assert_eq!(seen(pool.clone(), s.clone()).await, 1, "élève : visible après validation");
    // modifier un contenu validé impose une revalidation
    assert!(as_app(&pool, &v, true, "UPDATE school_language_contents SET body='Contenu modifié sans relecture'").await.unwrap_err().contains("STEP_ORDER"));
}

#[tokio::test]
async fn t05_audio_annotation_requires_rights_consent_and_second_reviewer() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (_, _, a) = user(&r, &pool, "annot@e.org", "contributor").await;
    let (_, _, v) = user(&r, &pool, "rev@e.org", "reviewer").await;
    // source sans preuve de droits ou sans consentement : refusée
    assert!(sqlx::query("INSERT INTO annotation_audio_sources VALUES ('s0','x','fon','CC-BY','','consent-1',now())").execute(&pool).await.is_err());
    assert!(sqlx::query("INSERT INTO annotation_audio_sources(source_id,title,language,license,rights_proof,speaker_consent_ref) VALUES ('s0','x','fon','CC-BY','contrat-1','c')").execute(&pool).await.is_err());
    sqlx::query("INSERT INTO annotation_audio_sources VALUES ('s1','Conte','fon','CC-BY-4.0','contrat-2026-01','consent-spk-7',now())").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO annotation_tasks(task_id,source_id,segment_start_ms,segment_end_ms) VALUES ('t1','s1',0,15000)").execute(&pool).await.unwrap();
    // soumission sans traduction refusée
    assert!(as_app(&pool, &a, false, &format!("UPDATE annotation_tasks SET author_id='{a}', transcription='Mi kú dé', status='to_review', submitted_at=now()")).await.unwrap_err().contains("STEP_ORDER"));
    assert_eq!(as_app(&pool, &a, false, &format!("UPDATE annotation_tasks SET author_id='{a}', transcription='Mi kú dé', translation_fr='Bonjour', status='to_review', submitted_at=now()")).await.unwrap(), 1);
    // livraison sans validation refusée ; auto-relecture refusée
    assert!(as_app(&pool, &v, true, "UPDATE annotation_tasks SET status='delivered', delivered_at=now()").await.unwrap_err().contains("STEP_ORDER"));
    assert!(as_app(&pool, &a, true, &format!("UPDATE annotation_tasks SET status='validated', reviewer_id='{a}', reviewed_at=now()")).await.unwrap_err().contains("SELF_REVIEW"));
    as_app(&pool, &v, true, &format!("UPDATE annotation_tasks SET status='validated', reviewer_id='{v}', reviewed_at=now()")).await.unwrap();
    as_app(&pool, &v, true, "UPDATE annotation_tasks SET status='delivered', delivered_at=now()").await.unwrap();
    // refus SAKC append-only
    sqlx::query("INSERT INTO sakc_import_refusals(resource_id,rights_status,reason) VALUES ('r1','unknown','droits non établis')").execute(&pool).await.unwrap();
    assert!(sqlx::query("DELETE FROM sakc_import_refusals").execute(&pool).await.is_err());
}
