//! Gateway ↔ School wiring tests against PostgreSQL 16 and a recording mock School upstream (real HTTP on 127.0.0.1).
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

async fn mock_school() -> (String, Log) {
    let log: Log = Arc::default();
    async fn h(State(l): State<Log>, uri: Uri, hm: HeaderMap, body: axum::body::Bytes) -> (StatusCode, Json<Value>) {
        let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let path = uri.path().to_string();
        l.lock().unwrap().push((path.clone(), hm, v));
        match path.as_str() {
            "/catalog" => (StatusCode::OK, Json(json!({"ok":true,"curricula":[{"id":"cur_x","name":"Prog <X>"}],"levels":[],"subjects":[]}))),
            "/workspace" => (StatusCode::OK, Json(json!({"ok":true,"profile":null,"documents":[{"id":"doc_1","title":"<script>alert(1)</script>"}],
                "exercises":[{"id":"exr_1","title":"Ex","difficulty":"INTERMEDIATE","questions_json":[{"id":"q1","prompt":"P1","maxPoints":10}]}],
                "submissions":[],"progressSummary":{"totalActivities":0}}))),
            "/documents" => (StatusCode::BAD_REQUEST, Json(json!({"ok":false,"error":{"code":"FORBIDDEN_FILE_TYPE","message":"no"}}))),
            _ => (StatusCode::CREATED, Json(json!({"ok":true,"submission":{"score":"12.5","max_score":"20","overall_feedback":"bien","corrections_json":[]}}))),
        }
    }
    let app = Router::new().fallback(any(h)).layer(axum::extract::DefaultBodyLimit::disable()).with_state(log.clone());
    let lis = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = lis.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(lis, app).await.unwrap() });
    (format!("http://{addr}"), log)
}

async fn setup(role_email: &str, role: &str) -> Option<(Router, Log, String, String)> {
    let pool = fresh_db().await?;
    let (url, log) = mock_school().await;
    let mut cfg = Config::test_default(); cfg.school_url = url;
    let r = app::router(app::AppState { pool, cfg: Arc::new(cfg), http: reqwest::Client::new() });
    let req = Request::post("/api/auth").header("host", "app.test").header("content-type", "application/json")
        .body(Body::from(json!({"action":"register","email":role_email,"password":"Password123!","fullName":"Ama K","role":role}).to_string())).unwrap();
    let res = r.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let (mut s, mut c) = (String::new(), String::new());
    for v in res.headers().get_all("set-cookie") { let kv = v.to_str().unwrap().split(';').next().unwrap();
        if let Some(x) = kv.strip_prefix("solob_session=") { s = x.into() } if let Some(x) = kv.strip_prefix("solob_csrf=") { c = x.into() } }
    Some((r, log, format!("solob_session={s}; solob_csrf={c}"), c))
}

async fn send(r: &Router, req: Request<Body>) -> (StatusCode, String) {
    let res = r.clone().oneshot(req).await.unwrap();
    let st = res.status();
    (st, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}
fn form(uri: &str, ck: &str, body: &str) -> Request<Body> {
    Request::post(uri).header("host", "app.test").header("cookie", ck).header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
async fn school_page_renders_forms_escaped_with_csrf() {
    let Some((r, _log, ck, csrf)) = setup("s1@e.org", "student").await else { return };
    let (st, html) = send(&r, Request::get("/school").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK);
    for a in ["/school/profile", "/school/upload", "/school/explain", "/school/generate", "/school/submit"] { assert!(html.contains(a), "missing {a}"); }
    assert!(html.contains(&format!("name=\"csrf\" value=\"{csrf}\"")));
    assert!(html.contains("&lt;script&gt;") && !html.contains("<script>"), "upstream data must be escaped");
    assert!(html.contains("enctype=\"multipart/form-data\"") && !html.contains("isTeacherResource"), "student gets no teacher checkbox");
}

#[tokio::test]
async fn school_forms_require_csrf_and_forward_identity_and_json() {
    let Some((r, log, ck, csrf)) = setup("s2@e.org", "student").await else { return };
    let (st, _) = send(&r, form("/school/submit", &ck, "exerciseId=exr_1&answer_q1=abc")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "no csrf field");
    let (st, _) = send(&r, form("/school/submit", &ck, "csrf=forged&exerciseId=exr_1")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "forged csrf");
    assert!(log.lock().unwrap().iter().all(|(p, _, _)| p != "/submissions"));
    let (st, html) = send(&r, form("/school/submit", &ck, &format!("csrf={csrf}&exerciseId=exr_1&answer_q1=La+lumi%C3%A8re&answer_q2=x"))).await;
    assert_eq!(st, StatusCode::OK, "{html}");
    assert!(html.contains("Correction : 12.5/20"));
    let l = log.lock().unwrap();
    let (_, hm, body) = l.iter().find(|(p, _, _)| p == "/submissions").unwrap();
    assert_eq!(body["exerciseId"], "exr_1"); assert_eq!(body["answers"]["q1"], "La lumière"); assert_eq!(body["answers"]["q2"], "x");
    assert_eq!(hm["x-solob-user-role"], "student"); assert_eq!(hm["x-solob-service-secret"], "test-service-secret");
    drop(l);
    let (st, _) = send(&r, form("/school/hack", &ck, &format!("csrf={csrf}"))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn multipart_upload_becomes_base64_json_and_errors_are_shown() {
    let Some((r, log, ck, csrf)) = setup("s3@e.org", "student").await else { return };
    let b = "XBOUNDARY";
    let body = format!("--{b}\r\nContent-Disposition: form-data; name=\"csrf\"\r\n\r\n{csrf}\r\n--{b}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nCours\r\n\
--{b}\r\nContent-Disposition: form-data; name=\"isTeacherResource\"\r\n\r\ntrue\r\n\
--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"evil.sh\"\r\nContent-Type: text/plain\r\n\r\n#!/bin/sh\r\n--{b}--\r\n");
    let req = Request::post("/school/upload").header("host", "app.test").header("cookie", &ck)
        .header("content-type", format!("multipart/form-data; boundary={b}")).body(Body::from(body)).unwrap();
    let (st, html) = send(&r, req).await;
    assert_eq!(st, StatusCode::BAD_REQUEST); assert!(html.contains("FORBIDDEN_FILE_TYPE"));
    let l = log.lock().unwrap();
    let (_, _, j) = l.iter().find(|(p, _, _)| p == "/documents").unwrap();
    assert_eq!(j["originalFileName"], "evil.sh"); assert_eq!(j["contentBase64"], "IyEvYmluL3No"); assert_eq!(j["mimeType"], "text/plain");
}

#[tokio::test]
async fn files_route_rbac_and_id_validation() {
    let Some((r, log, ck, _)) = setup("c1@e.org", "org_client").await else { return };
    let (st, _) = send(&r, Request::get("/api/files/fil_abc").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = send(&r, Request::get("/api/files/..%2Fetc").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, _) = send(&r, Request::get("/api/files/fil_abc").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert!(st.is_success(), "business role may ask; the owning service decides");
    assert!(log.lock().unwrap().iter().any(|(p, hm, _)| p == "/files/fil_abc" && hm["x-solob-user-role"] == "org_client"));
    // business role cannot use School forms
    let (st, _) = send(&r, Request::get("/school").header("cookie", &ck).body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn school_api_accepts_base64_bodies_above_default_limit() {
    let Some((r, log, ck, csrf)) = setup("s4@e.org", "student").await else { return };
    let big = "A".repeat(5 * 1024 * 1024);
    let req = Request::post("/api/school/documents").header("host", "app.test").header("cookie", &ck).header("x-solob-csrf", &csrf)
        .header("content-type", "application/json").body(Body::from(json!({"title":"t","contentBase64":big}).to_string())).unwrap();
    let (st, _) = send(&r, req).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "reached upstream (mock answers 400), not 413 at the gateway");
    assert!(log.lock().unwrap().iter().any(|(p, _, _)| p == "/documents"));
    let huge = "A".repeat(17 * 1024 * 1024);
    let req = Request::post("/api/school/documents").header("host", "app.test").header("cookie", &ck).header("x-solob-csrf", &csrf)
        .header("content-type", "application/json").body(Body::from(huge)).unwrap();
    assert_eq!(send(&r, req).await.0, StatusCode::PAYLOAD_TOO_LARGE);
}
