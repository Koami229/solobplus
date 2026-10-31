use solob_gateway::{app, auth, config::Config, db};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // `solob-gateway healthcheck`: container HEALTHCHECK for the distroless image (no shell/curl).
    // Runs before config/DB so it needs no secrets; exits 0 only on HTTP 200 from /api/health.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") { std::process::exit(healthcheck()); }
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

fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8100".into());
    let port = addr.rsplit(':').next().unwrap_or("8100").to_string();
    let target = format!("127.0.0.1:{port}");
    let Ok(sock) = target.parse::<std::net::SocketAddr>() else { return 1 };
    let Ok(mut c) = std::net::TcpStream::connect_timeout(&sock, std::time::Duration::from_secs(3)) else { return 1 };
    let _ = c.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    if c.write_all(format!("GET /api/health HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n").as_bytes()).is_err() { return 1 }
    let mut buf = [0u8; 64];
    let n = c.read(&mut buf).unwrap_or(0);
    if String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200") { 0 } else { 1 }
}
