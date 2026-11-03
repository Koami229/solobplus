//! Public demo: every page is reachable without an account, keeps the strict CSP and contains no script.
//! Needs no database: the pool is lazy and demo handlers never query it.
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use solob_gateway::{app, config::Config, demo};
use std::sync::Arc;
use tower::ServiceExt;

fn router() -> Router {
    let pool = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://nobody:x@127.0.0.1:1/none").unwrap();
    app::router(app::AppState { pool, cfg: Arc::new(Config::test_default()), http: reqwest::Client::new() })
}

async fn get(r: &Router, p: &str) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = r.clone().oneshot(Request::get(p).body(Body::empty()).unwrap()).await.unwrap();
    let (st, hm) = (res.status(), res.headers().clone());
    (st, hm, String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

fn routes() -> Vec<String> {
    let mut v = vec!["/demo".to_string()];
    v.extend(demo::BUSINESS.iter().map(|(s, _, _)| format!("/demo/business/{s}")));
    v.extend(demo::SCHOOL.iter().map(|(s, _, _)| format!("/demo/school/{s}")));
    v.push("/demo/school/solob-ai?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E".into());
    v
}

#[tokio::test]
async fn demo_has_8_business_and_11_school_pages() {
    assert_eq!(demo::BUSINESS.len(), 8);
    assert_eq!(demo::SCHOOL.len(), 11);
}

#[tokio::test]
async fn every_demo_page_is_public_csp_strict_and_script_free() {
    let r = router();
    for p in routes() {
        let (st, hm, b) = get(&r, &p).await;
        assert_eq!(st, StatusCode::OK, "{p}");
        let csp = hm["content-security-policy"].to_str().unwrap();
        assert!(csp.contains("script-src 'self'") && csp.contains("style-src 'self'") && !csp.contains("unsafe-inline"), "{p}");
        assert_eq!(hm["x-frame-options"], "DENY");
        assert_eq!(hm["x-content-type-options"], "nosniff");
        let low = b.to_lowercase();
        assert!(!low.contains("<script"), "script in {p}");
        assert!(!low.contains(" style=\""), "inline style in {p}");
        assert!(!low.contains(" on") || !regex_like_handler(&low), "inline handler in {p}");
        assert!(b.contains("Démo — données fictives"), "badge missing in {p}");
        assert!(!b.contains("href=\"http"), "external link in {p}");
        assert!(!b.contains("<form method=\"post\""), "post form in {p}");
    }
}

fn regex_like_handler(s: &str) -> bool {
    ["onclick=", "onload=", "onerror=", "onsubmit=", "onmouseover="].iter().any(|h| s.contains(h))
}

#[tokio::test]
async fn demo_links_resolve() {
    let r = router();
    for p in routes() {
        let (_, _, b) = get(&r, &p).await;
        for part in b.split("href=\"").skip(1) {
            let href = part.split('"').next().unwrap();
            if href.starts_with("/demo") {
                let path = href.split('#').next().unwrap();
                let (st, _, _) = get(&r, path).await;
                assert!(st == StatusCode::OK || st.is_redirection(), "{p} -> {href}: {st}");
            }
        }
    }
}

#[tokio::test]
async fn demo_css_served_and_unknown_page_404() {
    let r = router();
    for c in ["/static/demo.css", "/static/home.css"] {
        let (st, hm, _) = get(&r, c).await;
        assert_eq!(st, StatusCode::OK); assert!(hm["content-type"].to_str().unwrap().starts_with("text/css"));
    }
    assert_eq!(get(&r, "/demo/school/inexistant").await.0, StatusCode::NOT_FOUND);
    assert_eq!(get(&r, "/demo/business/inexistant").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn demo_question_is_escaped_and_not_stored() {
    let (st, _, b) = get(&router(), "/demo/school/solob-ai?q=%3Cb%3Ex%3C%2Fb%3E").await;
    assert_eq!(st, StatusCode::OK);
    assert!(b.contains("&lt;b&gt;x&lt;/b&gt;"));
    assert!(b.contains("SOLOB AI n'est pas appelé"));
}


#[tokio::test]
async fn https_mode_adds_hsts() {
    let pool = sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://nobody:x@127.0.0.1:1/none").unwrap();
    let mut cfg = Config::test_default(); cfg.https = true;
    let r = app::router(app::AppState { pool, cfg: Arc::new(cfg), http: reqwest::Client::new() });
    let (st, hm, _) = get(&r, "/demo").await;
    assert_eq!(st, StatusCode::OK);
    assert!(hm["strict-transport-security"].to_str().unwrap().contains("max-age="));
    assert!(!get(&router(), "/demo").await.1.contains_key("strict-transport-security"));
}
