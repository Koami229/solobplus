use solob_gateway::{app, auth, config::Config, db};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let cfg = Config::from_env().unwrap_or_else(|e| { eprintln!("{e}"); std::process::exit(1) });
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| { eprintln!("FATAL: DATABASE_URL is required."); std::process::exit(1) });
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(10).connect(&url).await.expect("database connection");
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("migrate") => { let a = db::migrate(&pool).await.expect("migrate"); println!("applied: {a:?}"); return; }
        Some("bootstrap-admin") => {
            db::migrate(&pool).await.expect("migrate");
            let g = |k: &str| std::env::var(k).unwrap_or_default();
            match auth::bootstrap_initial_admin(&pool, &g("BOOTSTRAP_ADMIN_EMAIL"), &g("BOOTSTRAP_ADMIN_PASSWORD"), &g("BOOTSTRAP_ADMIN_NAME"),
                &std::env::var("BOOTSTRAP_ADMIN_COUNTRY").unwrap_or_else(|_| "BJ".into())).await {
                Ok(id) => println!("initial admin created: {id}"),
                Err(e) => { eprintln!("{e}"); std::process::exit(2) }
            }
            return;
        }
        _ => {}
    }
    db::migrate(&pool).await.expect("migrate");
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8100".into());
    let state = app::AppState { pool, cfg: Arc::new(cfg), http: reqwest::Client::new() };
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("SOLOB+ gateway listening on http://{addr}");
    axum::serve(listener, app::router(state)).await.unwrap();
}
