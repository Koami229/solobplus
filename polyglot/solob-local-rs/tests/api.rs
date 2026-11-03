//! API HTTP : contrat local_provider.py, limites (taille, max_new_tokens, langue), santé, refus des adresses non locales.
use axum::{body::Body, http::{Request, StatusCode}};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tower::ServiceExt;

fn env(m: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let h: HashMap<String, String> = m.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    move |k| h.get(k).cloned()
}

#[test]
fn disabled_unless_configured_and_loopback_only() {
    assert!(solob_local::Config::from_env(env(&[])).is_err());
    assert!(solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "0"), ("SOLOB_LOCAL_MODEL_DIR", "/x")])).is_err());
    let c = solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "1"), ("SOLOB_LOCAL_MODEL_DIR", "/x")])).unwrap();
    assert_eq!(c.bind.to_string(), "127.0.0.1:8300"); assert_eq!(c.max_new_tokens_cap, 512);
    for bad in ["0.0.0.0:8300", "192.168.1.10:8300", "[::]:8300", "8.8.8.8:80"] {
        let e = solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "1"), ("SOLOB_LOCAL_MODEL_DIR", "/x"), ("SOLOB_LOCAL_BIND", bad)]));
        assert!(e.is_err(), "{bad} doit être refusé");
    }
    assert!(solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "1"), ("SOLOB_LOCAL_MODEL_DIR", "/x"), ("SOLOB_LOCAL_BIND", "[::1]:9")])).is_ok());
    let c = solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "1"), ("SOLOB_LOCAL_MODEL_DIR", "/x"), ("SOLOB_LOCAL_MAX_NEW_TOKENS_CAP", "99999")])).unwrap();
    assert_eq!(c.max_new_tokens_cap, 512, "plafond dur 512");
}

fn app(timeout_ms: &str) -> Option<axum::Router> {
    let d = std::env::var("SOLOB_LOCAL_PARITY_DIRS").ok()?.split(':').next()?.to_string();
    let cfg = solob_local::Config::from_env(env(&[("SOLOB_LOCAL_SERVE", "1"), ("SOLOB_LOCAL_MODEL_DIR", &d), ("SOLOB_LOCAL_TIMEOUT_MS", timeout_ms)])).unwrap();
    let e = solob_local::Engine::load(&cfg.model_dir).unwrap();
    Some(solob_local::router(solob_local::state(e, cfg)))
}
async fn call(r: &axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = r.clone().oneshot(req).await.unwrap(); let st = res.status();
    let b = res.into_body().collect().await.unwrap().to_bytes();
    (st, serde_json::from_slice(&b).unwrap_or(Value::Null))
}
fn post(body: String) -> Request<Body> { Request::post("/generate").header("content-type", "application/json").body(Body::from(body)).unwrap() }

#[tokio::test]
async fn generate_contract_and_limits() {
    let Some(r) = app("10000") else { eprintln!("SKIP: SOLOB_LOCAL_PARITY_DIRS unset"); return };
    let (st, h) = call(&r, Request::get("/healthz").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK); assert_eq!(h["status"], "ok");
    let (st, v) = call(&r, post(json!({"prompt": "Le Bénin est", "max_new_tokens": 8}).to_string())).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["text"].is_string()); assert!(v["completion_tokens"].as_u64().unwrap() <= 8);
    assert!(v["model"].as_str().unwrap().starts_with("solob-local:")); assert_eq!(v["experimental"], true);
    // Déterministe (glouton)
    let (_, v2) = call(&r, post(json!({"prompt": "Le Bénin est", "max_new_tokens": 8}).to_string())).await;
    assert_eq!(v["text"], v2["text"]);
    for (body, want) in [
        (json!({"prompt": "x", "max_new_tokens": 513}).to_string(), StatusCode::BAD_REQUEST),
        (json!({"prompt": "x", "max_new_tokens": 0}).to_string(), StatusCode::BAD_REQUEST),
        (json!({"prompt": "", "max_new_tokens": 4}).to_string(), StatusCode::PAYLOAD_TOO_LARGE),
        (json!({"prompt": "a".repeat(4001), "max_new_tokens": 4}).to_string(), StatusCode::PAYLOAD_TOO_LARGE),
        (json!({"prompt": "x", "lang": "xx"}).to_string(), StatusCode::BAD_REQUEST),
        (json!({"prompt": "x", "evil": 1}).to_string(), StatusCode::BAD_REQUEST),
        ("not json".to_string(), StatusCode::BAD_REQUEST),
    ] { assert_eq!(call(&r, post(body.clone())).await.0, want, "{body}"); }
    // Corps > 16 Kio refusé avant parsing
    assert_eq!(call(&r, post(json!({"prompt": "é".repeat(20_000)}).to_string())).await.0, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn generation_respects_timeout() {
    let Some(r) = app("100") else { return };
    // 100 ms : le délai est vérifié entre chaque token ; on force beaucoup de tokens sur un long prompt.
    let t = std::time::Instant::now();
    let (st, v) = call(&r, post(json!({"prompt": "Le Bénin est un pays ".repeat(100), "max_new_tokens": 512}).to_string())).await;
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(st == StatusCode::GATEWAY_TIMEOUT || st == StatusCode::OK, "{st} {v}");
}

#[test]
fn engine_stops_at_deadline() {
    let Some(d) = std::env::var("SOLOB_LOCAL_PARITY_DIRS").ok().and_then(|v| v.split(':').next().map(String::from)) else { return };
    let e = solob_local::Engine::load(std::path::Path::new(&d)).unwrap();
    let ids = e.encode("fr", "Le Bénin").unwrap();
    let (out, timed_out) = e.generate(ids, 512, std::time::Instant::now()).unwrap();
    assert!(timed_out); assert!(out.is_empty());
}
