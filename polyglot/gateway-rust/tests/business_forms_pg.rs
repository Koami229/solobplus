//! Gateway ↔ Business wiring tests against PostgreSQL 16 and a recording mock Java upstream (real HTTP on 127.0.0.1).
use axum::{body::Body, extract::State, http::{HeaderMap, Request, StatusCode, Uri}, routing::any, Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use solob_gateway::{app, config::Config, crypto, db};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Log = Arc<Mutex<Vec<(String, HeaderMap, Value)>>>;

async fn fresh_db() -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else { eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset"); return None };
    let name = format!("solob_it_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}")).execute(&a).await.unwrap();
    let pool = PgPool::connect(&format!("{}/{}", admin.rsplit_once('/').unwrap().0, name)).await.unwrap();
    db::migrate(&pool).await.unwrap();
    Some(pool)
}

async fn mock(tag: &'static str) -> (String, Log) {
    let log: Log = Arc::default();
    async fn h(State((l, tag)): State<(Log, &'static str)>, uri: Uri, hm: HeaderMap, body: axum::body::Bytes) -> (StatusCode, Json<Value>) {
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let path = uri.path().to_string();
        l.lock().unwrap().push((path.clone(), hm.clone(), v.clone()));
        if path.starts_with("/files/") { return (StatusCode::OK, Json(json!({"ok":true,"served_by":tag}))); }
        match path.as_str() {
            "/workspace" => { let me = hm.get("x-solob-user-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let w = json!({"ok":true,"workspace":{
                "projects":[{"id":"prj_1","title":"<script>x</script>","status":"SUBMITTED","budget_amount":1000,"budget_currency":"XOF"}],
                "tasks":[{"id":"tsk_1","title":"T1","language_code":"fon","status":"SUBMITTED","assigned_contributor_id":"me","source_file_id":"fil_b"}],
                "submissions":[{"id":"sub_own","task_title":"Mine","status":"SUBMITTED","contributor_user_id":"__SELF__","revision_number":1},
                               {"id":"sub_other","task_title":"Other","status":"SUBMITTED","contributor_user_id":"usr_other","revision_number":1}],
                "compensations":[],"deliveryReports":[],"talentDirectory":[]}});
                (StatusCode::OK, Json(serde_json::from_str(&w.to_string().replace("__SELF__", &me)).unwrap())) }
            "/matches/prj_1" => (StatusCode::OK, Json(json!({"ok":true,"candidates":[{"userId":"u1","fullName":"Kofi <b>","matchScore":52.5,"eligibleForVerifiedAssignment":true,"explanationReasons":["Verified assessment passed for language(s): FON"]}]}))),
            "/actions" if v["action"] == "review_submission" && v["submissionId"] == "sub_own" =>
                (StatusCode::FORBIDDEN, Json(json!({"ok":false,"error":{"code":"SELF_REVIEW_FORBIDDEN","message":"no"}}))),
            _ => (StatusCode::CREATED, Json(json!({"ok":true}))),
        }
    }
    let app = Router::new().fallback(any(h)).layer(axum::extract::DefaultBodyLimit::disable()).with_state((log.clone(), tag));
    let lis = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = lis.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(lis, app).await.unwrap() });
    (format!("http://{addr}"), log)
}

struct Ctx { r: Router, pool: PgPool, blog: Log, slog: Log, ck: String, csrf: String, uid: String }

/// Registers a contributor, then (privileged roles cannot self-register) promotes it in SQL.
async fn setup(email: &str, role: &str) -> Option<Ctx> {
    let pool = fresh_db().await?;
    let (burl, blog) = mock("java").await; let (surl, slog) = mock("python").await;
    let mut cfg = Config::test_default(); cfg.business_url = burl; cfg.school_url = surl;
    let r = app::router(app::AppState { pool: pool.clone(), cfg: Arc::new(cfg), http: reqwest::Client::new() });
    let req = Request::post("/api/auth").header("host", "app.test").header("content-type", "application/json")
        .body(Body::from(json!({"action":"register","email":email,"password":"Password123!","fullName":"Ama K","role":"contributor"}).to_string())).unwrap();
    let res = r.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let (mut s, mut c) = (String::new(), String::new());
    for v in res.headers().get_all("set-cookie") { let kv = v.to_str().unwrap().split(';').next().unwrap();
        if let Some(x) = kv.strip_prefix("solob_session=") { s = x.into() } if let Some(x) = kv.strip_prefix("solob_csrf=") { c = x.into() } }
    sqlx::query("UPDATE users SET role=$1 WHERE email=$2").bind(role).bind(email).execute(&pool).await.unwrap();
    let uid: String = sqlx::query_scalar("SELECT id FROM users WHERE email=$1").bind(email).fetch_one(&pool).await.unwrap();
    Some(Ctx { r, pool, blog, slog, ck: format!("solob_session={s}; solob_csrf={c}"), csrf: c, uid })
}
async fn send(r: &Router, req: Request<Body>) -> (StatusCode, String) {
    let res = r.clone().oneshot(req).await.unwrap();
    let st = res.status();
    (st, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}
fn form(uri: &str, ck: &str, body: &str) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
}
fn get(uri: &str, ck: &str) -> Request<Body> { Request::get(uri).header("cookie", ck).body(Body::empty()).unwrap() }

#[tokio::test]
async fn operator_page_has_all_forms_escaped_with_csrf() {
    let Some(c) = setup("op@e.org", "operator").await else { return };
    let (st, html) = send(&c.r, get("/business", &c.ck)).await;
    assert_eq!(st, StatusCode::OK, "{html}");
    for a in ["/business/create_project", "/business/review_project", "/business/record_assessment", "/business/create_assign_task",
              "/business/finalize_delivery", "/business/update_compensation", "/business/review_submission", "/business/matches"] {
        assert!(html.contains(a), "missing {a}");
    }
    assert!(html.contains(&format!("name=\"csrf\" value=\"{}\"", c.csrf)));
    assert!(html.contains("&lt;script&gt;") && !html.contains("<script>"));
    assert!(html.contains("href=\"/api/files/fil_b\""));
}

#[tokio::test]
async fn reviewer_never_gets_own_submission_and_contributor_has_no_operator_forms() {
    let Some(c) = setup("rv@e.org", "reviewer").await else { return };
    // the mock marks sub_own as authored by the calling user: the review form must not offer it
    let (_, html) = send(&c.r, get("/business", &c.ck)).await;
    assert!(html.contains("sub_other") && !html.contains("sub_own"), "{html}");
    assert!(!html.contains("create_assign_task") && !html.contains("update_compensation"));
    let Some(k) = setup("ct@e.org", "contributor").await else { return };
    let (st, html) = send(&k.r, get("/business", &k.ck)).await;
    assert_eq!(st, StatusCode::OK);
    assert!(html.contains("/business/upsert_talent_profile") && !html.contains("/business/review_submission") && !html.contains("/business/record_assessment"));
}

#[tokio::test]
async fn business_forms_require_csrf_and_forward_typed_json() {
    let Some(c) = setup("op2@e.org", "operator").await else { return };
    let (st, _) = send(&c.r, form("/business/create_assign_task", &c.ck, "projectId=prj_1")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "no csrf");
    let (st, _) = send(&c.r, form("/business/create_assign_task", &c.ck, "csrf=forged&projectId=prj_1")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "forged csrf");
    assert!(c.blog.lock().unwrap().iter().all(|(p, _, _)| p != "/actions"));
    let (st, html) = send(&c.r, form("/business/create_assign_task", &c.ck, &format!(
        "csrf={}&projectId=prj_1&title=T&instructions=I&languageCode=fon&assignedContributorId=u1&assignedReviewerId=&compensationCents=1200", c.csrf))).await;
    assert_eq!(st, StatusCode::OK, "{html}");
    let l = c.blog.lock().unwrap();
    let (_, hm, b) = l.iter().find(|(p, _, _)| p == "/actions").unwrap();
    assert_eq!(b["action"], "create_assign_task"); assert_eq!(b["compensationCents"], 1200.0); assert!(b["assignedReviewerId"].is_null());
    assert!(b.get("csrf").is_none(), "csrf token must not leak upstream");
    assert_eq!(hm["x-solob-user-role"], "operator"); assert_eq!(hm["x-solob-user-id"], c.uid.as_str());
    drop(l);
    let (st, html) = send(&c.r, form("/business/review_submission", &c.ck, &format!("csrf={}&submissionId=sub_own&decision=APPROVE&qualityScore=90&feedback=ok", c.csrf))).await;
    assert_eq!(st, StatusCode::FORBIDDEN); assert!(html.contains("SELF_REVIEW_FORBIDDEN"));
    let (st, _) = send(&c.r, form("/business/hack", &c.ck, &format!("csrf={}", c.csrf))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, html) = send(&c.r, get("/business/matches?projectId=prj_1", &c.ck)).await;
    assert_eq!(st, StatusCode::OK); assert!(html.contains("52.5") && html.contains("Kofi &lt;b&gt;"));
    let (st, _) = send(&c.r, get("/business/matches?projectId=..%2Fx", &c.ck)).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn student_denied_and_files_routed_by_pillar() {
    let Some(c) = setup("st@e.org", "student").await else { return };
    assert_eq!(send(&c.r, get("/business", &c.ck)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&c.r, form("/business/submit_work", &c.ck, &format!("csrf={}", c.csrf))).await.0, StatusCode::FORBIDDEN);
    sqlx::query("INSERT INTO stored_files (id,owner_user_id,pillar,original_name,storage_key,mime_type,size_bytes,sha256_checksum) VALUES ('fil_b',$1,'business','a.txt','k','text/plain',1,'x'),('fil_s',$1,'school','a.txt','k2','text/plain',1,'x')")
        .bind(&c.uid).execute(&c.pool).await.unwrap();
    let (st, b) = send(&c.r, get("/api/files/fil_b", &c.ck)).await;
    assert_eq!(st, StatusCode::OK); assert!(b.contains("java"));
    let (_, b) = send(&c.r, get("/api/files/fil_s", &c.ck)).await; assert!(b.contains("python"));
    let (_, b) = send(&c.r, get("/api/files/fil_unknown", &c.ck)).await; assert!(b.contains("python"), "unknown ids go to School (404 there)");
    assert!(c.blog.lock().unwrap().iter().any(|(p, hm, _)| p == "/files/fil_b" && hm["x-solob-service-secret"] == "test-service-secret-0123456789abcdef"));
    assert!(c.slog.lock().unwrap().iter().all(|(p, _, _)| p != "/files/fil_b"));
}
