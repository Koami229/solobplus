//! Stories Must du lancement (migration 009) : S04, T01, C01, C02, P02, FTS français, RLS, Argon2.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use chrono::{Datelike, Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, config::Config, crypto, db, launch_ui};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const AI: &[&str] = &[
    include_str!("../../../db/migrations-ai/004_sakc.sql"), include_str!("../../../db/migrations-ai/005_human_review.sql"),
    include_str!("../../../db/migrations-ai/006_contributions.sql"), include_str!("../../../db/migrations-ai/007_training_usage.sql"),
    include_str!("../../../db/migrations-ai/008_consent_v2.sql"), include_str!("../../../db/migrations-ai/009_launch_must.sql"),
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
/// Prochain jour ouvré à 10:00 heure du Bénin, au moins 2 jours plus tard (+k jours ouvrés).
fn slot(k: i64) -> String {
    let mut d = (Utc::now() + Duration::hours(1)).date_naive() + Duration::days(2);
    let mut left = k;
    loop { if d.weekday().number_from_monday() <= 5 { if left == 0 { break } left -= 1; } d += Duration::days(1); }
    format!("{}T10:00", d.format("%Y-%m-%d"))
}

#[tokio::test]
async fn launch_pages_disabled_without_009() {
    let Some(pool) = fresh_db(false).await else { return };
    let r = router(&pool);
    let (ck, _, _) = user(&r, &pool, "s@e.org", "student").await;
    let (st, _, b) = send(&r, get("/school/exams", &ck)).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE); assert!(b.contains("non activé"));
}

#[tokio::test]
async fn s04_mock_exam_timed_graded_server_side_and_progress_kept() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, _) = user(&r, &pool, "eleve@e.org", "student").await;
    let (ck2, c2, _) = user(&r, &pool, "autre@e.org", "student").await;
    let (cko, _, _) = user(&r, &pool, "client@e.org", "org_client").await;
    // Liste : pilote BEPC gratuit, marqué non vérifié ; rôle hors School refusé.
    let (st, _, b) = send(&r, get("/school/exams", &ck)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("BEPC blanc") && b.contains("non vérifié") && b.contains("gratuit"));
    assert_eq!(send(&r, get("/school/exams", &cko)).await.0, StatusCode::FORBIDDEN);
    // CSRF obligatoire.
    assert_eq!(send(&r, form("/school/exams/start", &ck, "exam_id=exam_bepc_bj_math_pilote")).await.0, StatusCode::FORBIDDEN);
    let (st, _, b) = send(&r, form("/school/exams/start", &ck, &format!("csrf={c}&exam_id=exam_bepc_bj_math_pilote"))).await;
    assert_eq!(st, StatusCode::OK, "{b}"); assert!(b.contains("À rendre avant") && b.contains("UTC+1"));
    assert!(!b.contains("\"answer\"") && !b.contains("Bonne réponse"), "le corrigé ne doit jamais être envoyé avant la remise");
    let att: String = sqlx::query_scalar("SELECT attempt_id FROM school_exam_attempts ORDER BY started_at DESC LIMIT 1").fetch_one(&pool).await.unwrap();
    // RLS : un autre élève ne voit pas la tentative, ni ne peut la rendre.
    assert_eq!(send(&r, get(&format!("/school/exams/attempt/{att}"), &ck2)).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&r, form("/school/exams/submit", &ck2, &format!("csrf={c2}&attempt_id={att}&q0=1"))).await.0, StatusCode::NOT_FOUND);
    // Correction serveur : 4 bonnes réponses sur 5 (q4 fausse), valeurs hors bornes ignorées.
    let (st, _, b) = send(&r, form("/school/exams/submit", &ck, &format!("csrf={c}&attempt_id={att}&q0=1&q1=1&q2=1&q3=2&q4=3&q9=0"))).await;
    assert_eq!(st, StatusCode::OK, "{b}"); assert!(b.contains("4/5") && b.contains("Bonne réponse") && !b.contains("hors délai"));
    assert_eq!(send(&r, form("/school/exams/submit", &ck, &format!("csrf={c}&attempt_id={att}&q0=1"))).await.0, StatusCode::CONFLICT);
    // Copie rendue après l'échéance : corrigée mais marquée hors délai.
    send(&r, form("/school/exams/start", &ck, &format!("csrf={c}&exam_id=exam_bepc_bj_math_pilote"))).await;
    let att2: String = sqlx::query_scalar("SELECT attempt_id FROM school_exam_attempts WHERE submitted_at IS NULL").fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE school_exam_attempts SET deadline_at = NOW() - interval '5 minutes' WHERE attempt_id=$1").bind(&att2).execute(&pool).await.unwrap();
    let (_, _, b) = send(&r, form("/school/exams/submit", &ck, &format!("csrf={c}&attempt_id={att2}&q0=1"))).await;
    assert!(b.contains("1/5") && b.contains("hors délai"));
    // Progression conservée et listée.
    let (_, _, b) = send(&r, get("/school/exams", &ck)).await;
    assert!(b.contains("Ma progression") && b.contains("4/5") && b.contains("1/5 — hors délai"));
    let (_, _, b) = send(&r, get("/school/exams", &ck2)).await;
    assert!(b.contains("Aucune tentative"));
    assert_eq!(audit_count(&pool, "MOCK_EXAM_SUBMITTED").await, 2);
}

#[tokio::test]
async fn t01_talent_journey_enforces_order_human_review_and_badge() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, tid) = user(&r, &pool, "talent@e.org", "contributor").await;
    let (ckr, cr, rid) = user(&r, &pool, "relecteur@e.org", "reviewer").await;
    let (_, _, b) = send(&r, get("/talent", &ck)).await;
    assert!(b.contains("Étape 1") && b.contains("Revue humaine") && b.contains("Badge"));
    // Entretien avant test réussi : refusé.
    let long = enc(&"J'ai annoté des enregistrements en fon en suivant le guide de qualité. ".repeat(2));
    assert_eq!(send(&r, form("/talent/interview", &ck, &format!("csrf={c}&answer={long}"))).await.0, StatusCode::CONFLICT);
    // Test échoué puis réussi (corrigé serveur).
    let (_, _, b) = send(&r, form("/talent/test", &ck, &format!("csrf={c}&skills=transcription%20fon&t0=0&t1=0&t2=1"))).await;
    assert!(b.contains("non réussi (0/3)"));
    assert_eq!(send(&r, form("/talent/interview", &ck, &format!("csrf={c}&answer={long}"))).await.0, StatusCode::CONFLICT);
    let (_, _, b) = send(&r, form("/talent/test", &ck, &format!("csrf={c}&skills=transcription%20fon&t0=1&t1=1&t2=0"))).await;
    assert!(b.contains("Test réussi (3/3)") && b.contains("Étape 2"));
    // Essai/badge avant revue humaine : refusé par le trigger d'ordre.
    assert_eq!(send(&r, form("/talent/trial", &ckr, &format!("csrf={cr}&user_id={tid}"))).await.0, StatusCode::CONFLICT);
    let (st, _, b) = send(&r, form("/talent/interview", &ck, &format!("csrf={c}&answer={long}"))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("en attente de revue humaine"));
    // Le talent ne peut pas se relire.
    assert_eq!(send(&r, form("/talent/review", &ck, &format!("csrf={c}&user_id={tid}&decision=approved&comment=ok"))).await.0, StatusCode::FORBIDDEN);
    let (_, _, b) = send(&r, get("/talent", &ckr)).await;
    assert!(b.contains("File de revue humaine") && b.contains(&tid));
    assert_eq!(send(&r, form("/talent/trial", &ckr, &format!("csrf={cr}&user_id={tid}"))).await.0, StatusCode::CONFLICT);
    let (st, _, _) = send(&r, form("/talent/review", &ckr, &format!("csrf={cr}&user_id={tid}&decision=approved&comment=Bon%20niveau"))).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _, b) = send(&r, form("/talent/trial", &ckr, &format!("csrf={cr}&user_id={tid}"))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("badge attribué"));
    let (_, _, b) = send(&r, get("/talent", &ck)).await;
    assert!(b.contains("Badge obtenu"));
    // Auto-revue bloquée en base même pour un relecteur.
    sqlx::query("INSERT INTO talent_journeys(user_id, skills, test_score, test_passed_at, interview_answer, interview_submitted_at) VALUES ($1,'x',3,NOW(),'y',NOW())").bind(&rid).execute(&pool).await.unwrap();
    assert_eq!(send(&r, form("/talent/review", &ckr, &format!("csrf={cr}&user_id={rid}&decision=approved&comment=moi"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(audit_count(&pool, "TALENT_BADGE_AWARDED").await, 1);
}

async fn badge(pool: &PgPool, uid: &str, reviewer: &str) {
    sqlx::query("INSERT INTO talent_journeys(user_id, skills, test_score, test_passed_at, interview_answer, interview_submitted_at, review_status, reviewer_id, reviewed_at, trial_validator_id, trial_validated_at, badge_at)
                 VALUES ($1,'traduction yoruba',3,NOW(),'réponse',NOW(),'approved',$2,NOW(),$2,NOW(),NOW())").bind(uid).bind(reviewer).execute(pool).await.unwrap();
}

#[tokio::test]
async fn c01_c02_client_request_call_booking_and_badged_shortlist() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, _) = user(&r, &pool, "client@e.org", "org_client").await;
    let (ck2, c2, _) = user(&r, &pool, "client2@e.org", "org_client").await;
    let (ckr, cr, rid) = user(&r, &pool, "equipe@e.org", "reviewer").await;
    let (_, _, t_ok) = user(&r, &pool, "badge@e.org", "contributor").await;
    let (_, _, t_no) = user(&r, &pool, "nonbadge@e.org", "contributor").await;
    badge(&pool, &t_ok, &rid).await;
    let need = enc("Transcrire 20 heures d'audio en fon pour un assistant vocal.");
    // Créneaux invalides.
    assert_eq!(send(&r, form("/client/request", &ck, &format!("csrf={c}&need={need}&call_at=2020-01-06T10:00"))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/client/request", &ck, &format!("csrf={c}&need={need}&call_at={}", slot(0).replace("T10:00", "T20:00")))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&r, form("/client/request", &ck, &format!("csrf={c}&need=court&call_at={}", slot(0)))).await.0, StatusCode::BAD_REQUEST);
    // Demande + appel enregistrés, confirmation avec fuseau.
    let (st, _, b) = send(&r, form("/client/request", &ck, &format!("csrf={c}&need={need}&skills=fon&tz=-5&call_at={}", slot(0)))).await;
    assert_eq!(st, StatusCode::OK, "{b}"); assert!(b.contains("Appel de 15 min confirmé") && b.contains("10:00 (heure du Bénin, UTC+1)") && b.contains("04:00 (UTC−5)") && b.contains("09:00 UTC"));
    assert_eq!(send(&r, form("/client/request", &ck, &format!("csrf={c}&need={need}&tz=99&call_at={}", slot(3)))).await.0, StatusCode::BAD_REQUEST);
    // Double réservation du même créneau refusée.
    assert_eq!(send(&r, form("/client/request", &ck2, &format!("csrf={c2}&need={need}&call_at={}", slot(0)))).await.0, StatusCode::CONFLICT);
    let (st, _, _) = send(&r, form("/client/request", &ck2, &format!("csrf={c2}&need={need}&call_at={}", slot(1)))).await;
    assert_eq!(st, StatusCode::OK);
    // RLS : chaque client ne voit que ses demandes.
    let (_, _, b) = send(&r, get("/client", &ck2)).await;
    assert_eq!(b.matches("Appel :").count(), 1);
    let req: String = sqlx::query_scalar("SELECT r.request_id FROM client_requests r JOIN users u ON u.id=r.client_id WHERE u.email='client@e.org'").fetch_one(&pool).await.unwrap();
    // Shortlist : réservée à l'équipe, talents badgés uniquement.
    assert_eq!(send(&r, form("/client/shortlist", &ck, &format!("csrf={c}&request_id={req}&talent_user_id={t_ok}"))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&r, form("/client/shortlist", &ckr, &format!("csrf={cr}&request_id={req}&talent_user_id={t_no}"))).await.0, StatusCode::CONFLICT);
    let (_, _, b) = send(&r, get("/client", &ckr)).await;
    assert!(b.contains("Demandes clients") && b.contains("Talent badge@e.org") && !b.contains("Talent nonbadge@e.org"));
    let (st, _, _) = send(&r, form("/client/shortlist", &ckr, &format!("csrf={cr}&request_id={req}&talent_user_id={t_ok}&note=Disponible"))).await;
    assert_eq!(st, StatusCode::OK);
    let (_, _, b) = send(&r, get("/client", &ck)).await;
    assert!(b.contains("badge SOLOB vérifié") && b.contains("traduction yoruba") && b.contains("shortlist_sent"));
    let (_, _, b) = send(&r, get("/client", &ck2)).await;
    assert!(!b.contains("badge SOLOB vérifié"), "la shortlist d'un autre client est invisible");
    assert_eq!(audit_count(&pool, "CLIENT_REQUEST_CREATED").await, 2);
    assert_eq!(audit_count(&pool, "CLIENT_SHORTLIST_ADD").await, 2); // 1 refus (rôle) + 1 succès
}

#[tokio::test]
async fn p02_account_deletion_request_has_due_date_and_is_logged() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, c, id) = user(&r, &pool, "u@e.org", "student").await;
    assert_eq!(send(&r, form("/account/deletion", &ck, &format!("csrf={c}"))).await.0, StatusCode::BAD_REQUEST);
    let (st, _, b) = send(&r, form("/account/deletion", &ck, &format!("csrf={c}&confirm=yes"))).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("traitement au plus tard"));
    send(&r, form("/account/deletion", &ck, &format!("csrf={c}&confirm=yes"))).await;
    let (n, days): (i64, f64) = sqlx::query_as("SELECT COUNT(*), MAX(EXTRACT(EPOCH FROM due_at - created_at)/86400)::float8 FROM privacy_requests WHERE user_id=$1 AND request_type='ACCOUNT_DELETION_REQUEST' AND status='PENDING_REVIEW'").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1); assert!((days - launch_ui::DELETION_DUE_DAYS as f64).abs() < 0.01);
    assert_eq!(audit_count(&pool, "ACCOUNT_DELETION_REQUESTED").await, 1);
    // Aucune suppression automatique : le compte existe toujours.
    let still: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id=$1").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(still, 1);
}

#[tokio::test]
async fn french_full_text_search_missions_with_stemming() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (ck, _, cid) = user(&r, &pool, "client@e.org", "org_client").await;
    sqlx::query("INSERT INTO organizations(id, owner_user_id, name, country, industry, contact_email) VALUES ('org_t',$1,'Org','BJ','IA','o@e.org')").bind(&cid).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO business_projects(id, organization_id, client_user_id, title, service_mode, service_category, description, deliverables_spec, acceptance_criteria, budget_amount_cents)
                 VALUES ('prj_t','org_t',$1,'Transcriptions des enregistrements médicaux','MANAGED_PROJECT','AFRICAN_LANG_TRANSCRIPTION_ANNOTATION','d','d','d',0)").bind(&cid).execute(&pool).await.unwrap();
    let (st, _, b) = send(&r, get("/search?q=enregistrement%20transcription", &ck)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("Transcriptions des enregistrements médicaux"), "{b}");
    let (_, _, b) = send(&r, get("/search?q=comptabilit%C3%A9", &ck)).await;
    assert!(!b.contains("médicaux"));
    let idx: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('sakc_resources_fts_idx','business_projects_fts_idx')").fetch_one(&pool).await.unwrap();
    assert_eq!(idx, 2);
}

#[tokio::test]
async fn rls_isolates_rows_for_application_role() {
    let Some(pool) = fresh_db(true).await else { return };
    let r = router(&pool);
    let (_, _, a) = user(&r, &pool, "a@e.org", "student").await;
    let (_, _, b) = user(&r, &pool, "b@e.org", "student").await;
    sqlx::query("INSERT INTO school_exam_attempts(attempt_id, exam_id, user_id, deadline_at) VALUES ('att_a','exam_bepc_bj_math_pilote',$1,NOW())").bind(&a).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.user_id',$1,true)").bind(&b).execute(&mut *tx).await.unwrap();
    sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM school_exam_attempts").fetch_one(&mut *tx).await.unwrap();
    assert_eq!(n, 0);
    let ins = sqlx::query("INSERT INTO school_exam_attempts(attempt_id, exam_id, user_id, deadline_at) VALUES ('att_x','exam_bepc_bj_math_pilote',$1,NOW())").bind(&a).execute(&mut *tx).await;
    assert!(ins.is_err(), "insertion au nom d'un autre utilisateur refusée par la RLS");
}

#[tokio::test]
async fn argon2_rehash_on_login_keeps_scrypt_valid() {
    let Some(pool) = fresh_db(false).await else { return };
    let r = router(&pool);
    let (_, _, id) = user(&r, &pool, "legacy@e.org", "student").await;
    let h0: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1").bind(&id).fetch_one(&pool).await.unwrap();
    assert!(h0.starts_with("$argon2id$"), "les nouveaux comptes sont en Argon2id");
    sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1").bind(&id).bind(crypto::hash_password_scrypt("Password123!")).execute(&pool).await.unwrap();
    let (st, _, _) = login(&r, "legacy@e.org").await;
    assert_eq!(st, StatusCode::OK);
    let h1: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1").bind(&id).fetch_one(&pool).await.unwrap();
    assert!(h1.starts_with("$argon2id$"));
    assert_eq!(login(&r, "legacy@e.org").await.0, StatusCode::OK);
    let (st, _, _) = send(&r, jpost("/api/auth", json!({"action":"login","email":"legacy@e.org","password":"wrong-pass-1"}))).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[test]
fn slot_rules() {
    let now = Utc::now();
    assert!(launch_ui::parse_slot("2020-01-06T10:00", now).is_err());
    assert!(launch_ui::parse_slot(&slot(0).replace(":00", ":10"), now).is_err());
    let t = launch_ui::parse_slot(&slot(0), now).unwrap();
    assert_eq!(chrono::Timelike::hour(&t), 9); // 10:00 au Bénin = 09:00 UTC
}
