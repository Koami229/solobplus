//! solob-local : serveur d'inférence EXPÉRIMENTAL du petit modèle SOLOB AI (CPU, candle), boucle locale uniquement.
//!
//! Contrat attendu par polyglot/school-python/solob_school/local_provider.py :
//!   POST /generate {"prompt": str, "max_new_tokens": int, "lang"?: str} -> {"text", "completion_tokens", "model", "experimental", "notice"}
//!   GET  /healthz -> {"status": "ok", "model": id}
//! Garde-fous : désactivé sauf SOLOB_LOCAL_SERVE=1, écoute 127.0.0.1 par défaut et refuse toute adresse non locale,
//! taille de requête bornée, max_new_tokens plafonné, délai global, une génération à la fois (503 sinon),
//! journaux JSON structurés SANS contenu utilisateur (seulement tailles, statut, latence).
pub mod model;

use anyhow::{bail, Context, Result};
use axum::{extract::{DefaultBodyLimit, State}, http::StatusCode, response::{IntoResponse, Response}, routing::{get, post}, Json, Router};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant}};
use tokio::sync::Semaphore;

pub const NOTICE: &str = "EXPERIMENTAL — petit modèle SOLOB AI (~3,4 M paramètres) non évalué pour l'usage pédagogique : ce texte n'est pas une réponse fiable.";
pub const LANGS: &[&str] = &["fr", "en", "fon", "yo", "ha", "wo", "ig", "sw"];

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub model_dir: PathBuf,
    pub max_body_bytes: usize,
    pub max_prompt_chars: usize,
    pub max_new_tokens_cap: usize,
    pub timeout: Duration,
}

impl Config {
    /// Lit l'environnement. Erreur si le service n'est pas explicitement activé ou si l'adresse n'est pas locale.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let on = get("SOLOB_LOCAL_SERVE").map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")).unwrap_or(false);
        if !on { bail!("solob-local est désactivé (définir SOLOB_LOCAL_SERVE=1 pour l'activer explicitement)"); }
        let bind: SocketAddr = get("SOLOB_LOCAL_BIND").unwrap_or_else(|| "127.0.0.1:8300".into()).parse().context("SOLOB_LOCAL_BIND invalide")?;
        if !bind.ip().is_loopback() { bail!("SOLOB_LOCAL_BIND doit être une adresse de boucle locale (127.0.0.1 / ::1), reçu {}", bind.ip()); }
        let model_dir = PathBuf::from(get("SOLOB_LOCAL_MODEL_DIR").context("SOLOB_LOCAL_MODEL_DIR requis")?);
        let num = |k: &str, d: usize, lo: usize, hi: usize| -> Result<usize> {
            let v = get(k).map(|s| s.trim().parse::<usize>().with_context(|| format!("{k} invalide"))).transpose()?.unwrap_or(d);
            Ok(v.clamp(lo, hi))
        };
        Ok(Self { bind, model_dir, max_body_bytes: num("SOLOB_LOCAL_MAX_BODY_BYTES", 16 * 1024, 1024, 64 * 1024)?,
            max_prompt_chars: num("SOLOB_LOCAL_MAX_PROMPT_CHARS", 4000, 1, 8000)?,
            max_new_tokens_cap: num("SOLOB_LOCAL_MAX_NEW_TOKENS_CAP", 512, 1, 512)?,
            timeout: Duration::from_millis(num("SOLOB_LOCAL_TIMEOUT_MS", 10_000, 100, 60_000)? as u64) })
    }
}

/// Vérifie les sha256 de manifest.json (fichiers exportés par tools/export_weights.py) avant tout chargement.
pub fn verify_manifest(dir: &Path) -> Result<()> {
    let m: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).context("manifest.json")?)?;
    let files = m["files"].as_object().context("manifest.files")?;
    for need in ["model.safetensors", "config.json", "tokenizer.model"] { if !files.contains_key(need) { bail!("manifest sans {need}"); } }
    for (name, h) in files {
        if name.contains('/') || name.contains("..") { bail!("nom de fichier invalide dans le manifest"); }
        let got = hex::encode(Sha256::digest(std::fs::read(dir.join(name)).with_context(|| name.clone())?));
        if Some(got.as_str()) != h.as_str() { bail!("empreinte sha256 différente pour {name}"); }
    }
    Ok(())
}

pub struct Engine { pub model: model::Gpt, pub sp: sentencepiece::SentencePieceProcessor, pub id: String }

impl Engine {
    pub fn load(dir: &Path) -> Result<Self> {
        verify_manifest(dir)?;
        let model = model::Gpt::load(dir)?;
        let sp = sentencepiece::SentencePieceProcessor::open(dir.join("tokenizer.model")).context("tokenizer.model")?;
        if sp.len() != model.cfg.vocab_size { bail!("taille du vocabulaire du tokenizer ({}) != modèle ({})", sp.len(), model.cfg.vocab_size); }
        let id = model.cfg.meta["id"].as_str().unwrap_or("unknown").to_string();
        Ok(Self { model, sp, id: format!("solob-local:{id}") })
    }
    /// Ids du prompt : <lang_x> + pièces SentencePiece (comme solob_ai.inference.offline_eval).
    pub fn encode(&self, lang: &str, prompt: &str) -> Result<Vec<u32>> {
        let lt = self.sp.piece_to_id(&format!("<lang_{lang}>"))?.context("token de langue absent du tokenizer")?;
        let mut ids = vec![lt];
        ids.extend(self.sp.encode(prompt)?.into_iter().map(|p| p.id));
        Ok(ids)
    }
    /// Génération gloutonne bornée par max_new et une échéance. Renvoie (ids générés, délai dépassé).
    pub fn generate(&self, mut ids: Vec<u32>, max_new: usize, deadline: Instant) -> Result<(Vec<u32>, bool)> {
        let eos = self.model.cfg.eos_id;
        let mut out = Vec::new();
        for _ in 0..max_new {
            if Instant::now() >= deadline { return Ok((out, true)); }
            let n = self.model.next_greedy(&ids)?;
            if eos >= 0 && n as i64 == eos { break; }
            out.push(n); ids.push(n);
        }
        Ok((out, false))
    }
}

#[derive(Clone)]
pub struct AppState { pub engine: Arc<Engine>, pub cfg: Arc<Config>, pub busy: Arc<Semaphore> }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GenReq { prompt: String, max_new_tokens: Option<usize>, lang: Option<String> }

fn err(st: StatusCode, code: &str) -> Response { (st, Json(json!({"error": {"code": code}}))).into_response() }

async fn healthz(State(s): State<AppState>) -> Response { Json(json!({"status": "ok", "model": s.engine.id, "experimental": true})).into_response() }

async fn generate(State(s): State<AppState>, body: Result<Json<GenReq>, axum::extract::rejection::JsonRejection>) -> Response {
    let t0 = Instant::now();
    let log = |status: &str, prompt_chars: usize, prompt_tokens: usize, completion: usize| {
        // Jamais le texte : seulement des tailles et le statut.
        tracing::info!(event = "generate", status, prompt_chars, prompt_tokens, completion_tokens = completion, latency_ms = t0.elapsed().as_millis() as u64);
    };
    let r = match body {
        Ok(Json(r)) => r,
        Err(e) if e.status() == StatusCode::PAYLOAD_TOO_LARGE => { log("body_too_large", 0, 0, 0); return err(StatusCode::PAYLOAD_TOO_LARGE, "BODY_TOO_LARGE") }
        Err(_) => { log("bad_request", 0, 0, 0); return err(StatusCode::BAD_REQUEST, "INVALID_JSON") }
    };
    let chars = r.prompt.chars().count();
    if chars == 0 || chars > s.cfg.max_prompt_chars { log("prompt_too_long", chars, 0, 0); return err(StatusCode::PAYLOAD_TOO_LARGE, "PROMPT_LENGTH") }
    let max_new = r.max_new_tokens.unwrap_or(64);
    if max_new == 0 || max_new > s.cfg.max_new_tokens_cap { log("bad_max_tokens", chars, 0, 0); return err(StatusCode::BAD_REQUEST, "MAX_NEW_TOKENS_RANGE") }
    let lang = r.lang.unwrap_or_else(|| "fr".into());
    if !LANGS.contains(&lang.as_str()) { log("bad_lang", chars, 0, 0); return err(StatusCode::BAD_REQUEST, "UNSUPPORTED_LANG") }
    let Ok(permit) = s.busy.clone().try_acquire_owned() else { log("busy", chars, 0, 0); return err(StatusCode::SERVICE_UNAVAILABLE, "BUSY") };
    let (eng, deadline) = (s.engine.clone(), t0 + s.cfg.timeout);
    let res = tokio::task::spawn_blocking(move || {
        let _p = permit;
        let ids = eng.encode(&lang, &r.prompt)?;
        let n = ids.len();
        let (out, timed_out) = eng.generate(ids, max_new, deadline)?;
        let text = eng.sp.decode_piece_ids(&out)?;
        anyhow::Ok((n, out.len(), text, timed_out))
    }).await;
    match res {
        Ok(Ok((_, c, _, true))) => { log("timeout", chars, 0, c); err(StatusCode::GATEWAY_TIMEOUT, "TIMEOUT") }
        Ok(Ok((n, c, text, false))) => {
            log("ok", chars, n, c);
            Json(json!({"text": text, "completion_tokens": c, "model": s.engine.id, "experimental": true, "notice": NOTICE})).into_response()
        }
        _ => { log("error", chars, 0, 0); err(StatusCode::INTERNAL_SERVER_ERROR, "INFERENCE_ERROR") }
    }
}

pub fn router(s: AppState) -> Router {
    let limit = s.cfg.max_body_bytes; let to = s.cfg.timeout + Duration::from_secs(1);
    Router::new().route("/generate", post(generate)).route("/healthz", get(healthz))
        .layer(DefaultBodyLimit::max(limit))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(StatusCode::GATEWAY_TIMEOUT, to))
        .with_state(s)
}

pub fn state(engine: Engine, cfg: Config) -> AppState { AppState { engine: Arc::new(engine), cfg: Arc::new(cfg), busy: Arc::new(Semaphore::new(1)) } }
