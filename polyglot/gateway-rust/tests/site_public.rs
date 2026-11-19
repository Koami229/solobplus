//! Site public : pages, CSRF anonyme, enregistrement des demandes.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use solob_gateway::{app, config::Config, crypto, db};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

async fn fresh_db() -> Option<PgPool> {
    let Ok(admin) = std::env::var("TEST_DATABASE_ADMIN_URL") else {
        eprintln!("SKIP: TEST_DATABASE_ADMIN_URL unset");
        return None;
    };
    let name = format!("solob_site_{}", crypto::random_hex(6));
    let a = PgPool::connect(&admin).await.unwrap();
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&a)
        .await
        .unwrap();
    let url = format!("{}/{}", admin.rsplit_once('/').unwrap().0, name);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::migrate(&pool).await.unwrap();
    Some(pool)
}

fn router(pool: PgPool) -> Router {
    app::router(app::AppState {
        pool,
        cfg: Arc::new(Config::test_default()),
        http: reqwest::Client::new(),
    })
}

async fn body_of(r: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = r.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}

fn csrf_cookie(hm: &axum::http::HeaderMap) -> String {
    hm.get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            v.split(';')
                .next()
                .and_then(|kv| kv.strip_prefix("solob_csrf="))
                .map(|s| s.to_string())
        })
        .unwrap()
}

#[tokio::test]
async fn public_pages_and_quote_are_stored() {
    let Some(pool) = fresh_db().await else { return };
    let r = router(pool.clone());
    let (st, hm, html) = body_of(
        &r,
        Request::get("/")
            .header("host", "app.test")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(html.contains("Une maison pour les langues"));
    assert!(!html.to_lowercase().contains("<script"));
    assert!(hm
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("script-src 'self'"));
    let token = csrf_cookie(&hm);
    assert_eq!(token.len(), 64);

    let paths = [
        "/studio",
        "/studio/restaurants",
        "/studio/motion",
        "/studio/airbnb",
        "/studio/immobilier",
        "/studio/hotels",
        "/staffing",
        "/staffing/candidater",
        "/core",
        "/core/annotation",
        "/core/evaluation",
        "/core/collecte",
        "/core/langues",
        "/school",
        "/trading",
        "/telegram",
        "/contact",
        "/confidentialite",
        "/static/site.css",
    ];
    for p in paths {
        let (st, _, text) = body_of(
            &r,
            Request::get(p)
                .header("host", "app.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{p}");
        assert!(!text.is_empty(), "{p}");
    }
    let font = r
        .clone()
        .oneshot(
            Request::get("/static/fonts/fraunces.woff2")
                .header("host", "app.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(font.status(), StatusCode::OK);
    assert_eq!(font.headers().get("content-type").unwrap(), "font/woff2");
    let (_, _, trading) = body_of(
        &r,
        Request::get("/trading")
            .header("host", "app.test")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(trading.contains("Aucun rendement"));
    let (_, _, school) = body_of(
        &r,
        Request::get("/school")
            .header("host", "app.test")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(school.contains("gratuit") && school.contains("/login"));

    let (st, _, _) = body_of(&r, Request::post("/contact").header("host", "app.test").header("content-type", "application/x-www-form-urlencoded")
        .header("origin", "http://app.test").body(Body::from("service=restaurants&full_name=Ama&email=ama@example.org&message=Un+site+pour+la+salle+du+soir")).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let form = format!("csrf={token}&service=restaurants&full_name=Ama%20K&email=Ama@Example.org&organization=Maison&message=Nous%20voulons%20un%20site%20pour%20la%20salle");
    let (st, hm, _) = body_of(
        &r,
        Request::post("/contact")
            .header("host", "app.test")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("origin", "http://app.test")
            .header("cookie", format!("solob_csrf={token}"))
            .body(Body::from(form))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER, "{hm:?}");
    assert_eq!(hm.get("location").unwrap(), "/contact/envoye");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM public_inquiries WHERE email = 'ama@example.org' AND service = 'restaurants' AND kind = 'quote'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1);
    for i in 0..3 {
        let again = format!("csrf={token}&service=motion&full_name=Ama%20K&email=Ama@Example.org&message=Message%20numero%20{i}%20pour%20le%20film");
        let (st, _, _) = body_of(
            &r,
            Request::post("/contact")
                .header("host", "app.test")
                .header("content-type", "application/x-www-form-urlencoded")
                .header("origin", "http://app.test")
                .header("cookie", format!("solob_csrf={token}"))
                .body(Body::from(again))
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::SEE_OTHER, "envoi {i}");
    }
    let blocked = format!("csrf={token}&service=motion&full_name=Ama%20K&email=Ama@Example.org&message=Celui-ci%20doit%20etre%20refuse%20par%20la%20limite");
    let (st, _, page) = body_of(
        &r,
        Request::post("/contact")
            .header("host", "app.test")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("origin", "http://app.test")
            .header("cookie", format!("solob_csrf={token}"))
            .body(Body::from(blocked))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS);
    assert!(page.contains("Trop de messages"));
    let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'PUBLIC_INQUIRY_CREATED' AND redacted_metadata_json::text NOT LIKE '%ama@example.org%'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(audits, 4);

    let talent = format!("csrf={token}&full_name=Kofi%20M&email=kofi@example.org&organization=Cotonou&languages=francais%2C%20fon&skills=Rust%2C%20Python&availability=rotation&message=Je%20cherche%20une%20equipe%20dediee");
    let (st, hm, _) = body_of(
        &r,
        Request::post("/staffing/candidater")
            .header("host", "app.test")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("origin", "http://app.test")
            .header("cookie", format!("solob_csrf={token}"))
            .body(Body::from(talent))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    assert_eq!(hm.get("location").unwrap(), "/staffing/candidature-envoyee");
    let kind: String =
        sqlx::query_scalar("SELECT kind FROM public_inquiries WHERE email = 'kofi@example.org'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kind, "talent");
}
