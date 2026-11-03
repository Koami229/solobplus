use std::io::{Read, Write};

fn healthcheck() -> i32 {
    let addr = std::env::var("SOLOB_LOCAL_BIND").unwrap_or_else(|_| "127.0.0.1:8300".into());
    let Ok(a) = addr.parse::<std::net::SocketAddr>() else { return 1 };
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&a, std::time::Duration::from_secs(3)) else { return 1 };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    if s.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").is_err() { return 1 }
    let mut b = String::new(); let _ = s.read_to_string(&mut b);
    if b.starts_with("HTTP/1.1 200") { 0 } else { 1 }
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") { std::process::exit(healthcheck()); }
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let cfg = match solob_local::Config::from_env(|k| std::env::var(k).ok()) {
        Ok(c) => c,
        Err(e) => { tracing::error!(event = "config", error = %e); std::process::exit(2) }
    };
    let engine = match solob_local::Engine::load(&cfg.model_dir) {
        Ok(e) => e,
        Err(e) => { tracing::error!(event = "load", error = %e); std::process::exit(3) }
    };
    tracing::info!(event = "start", bind = %cfg.bind, model = %engine.id, n_params = engine.model.cfg.n_params, experimental = true);
    let bind = cfg.bind;
    let app = solob_local::router(solob_local::state(engine, cfg));
    let l = tokio::net::TcpListener::bind(bind).await.expect("bind");
    axum::serve(l, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await.expect("serve");
}
