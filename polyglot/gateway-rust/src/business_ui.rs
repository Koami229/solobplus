//! SOLOB Business server-rendered forms (no JavaScript). Same pipeline as School: session → RBAC → CSRF (HMAC bound
//! to the session) → mutation rate limit → internal Java Business service with trusted identity headers.
//! Forms shown depend on the role, but the Java service re-checks every rule (RBAC, self-review ban, audits).
use crate::{app::AppState, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub async fn business_call(s: &AppState, u: &rbac::AuthUser, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(u16, Value), AppError> {
    let url = format!("{}/{}", s.cfg.business_url.trim_end_matches('/'), path);
    let mut rb = s.http.request(method, &url)
        .header("x-solob-service-secret", &s.cfg.service_secret)
        .header("x-solob-user-id", &u.id).header("x-solob-user-role", &u.role).header("x-solob-user-email", &u.email)
        .timeout(std::time::Duration::from_secs(20));
    if let Some(b) = body { rb = rb.json(&b); }
    let r = rb.send().await.map_err(|e| { eprintln!("upstream business error: {e}");
        AppError::new(502, "UPSTREAM_UNAVAILABLE", "SOLOB business service is unavailable.") })?;
    let st = r.status().as_u16();
    Ok((st, r.json::<Value>().await.unwrap_or(Value::Null)))
}

async fn session(s: &AppState, hm: &HeaderMap) -> Result<(rbac::AuthUser, String), AppError> {
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), rbac::BUSINESS_ROLES, "business", "UI")?;
    Ok((u.unwrap(), tok.unwrap()))
}

fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}
fn s_(v: &Value, k: &str) -> String { match v.get(k) { Some(Value::String(x)) => x.clone(), Some(Value::Null) | None => String::new(), Some(x) => x.to_string() } }
fn arr(v: &Value) -> Vec<Value> { v.as_array().cloned().unwrap_or_default() }
fn options(items: &[Value], label: impl Fn(&Value) -> String) -> String {
    items.iter().map(|i| format!("<option value=\"{}\">{}</option>", esc(&s_(i, "id")), esc(&label(i)))).collect()
}
fn sel(values: &[&str]) -> String { values.iter().map(|v| format!("<option>{v}</option>")).collect() }

pub async fn render(s: &AppState, u: &rbac::AuthUser, tok: &str, flash: Option<(bool, String)>, result: Option<String>) -> Result<String, AppError> {
    let csrf = esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok));
    let hidden = format!("<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">");
    let (_, ws0) = business_call(s, u, reqwest::Method::GET, "workspace", None).await?;
    let ws = ws0.get("workspace").cloned().unwrap_or(Value::Null);
    let role = u.role.as_str();
    let op = role == "operator" || role == "admin";
    let projects = arr(&ws["projects"]); let tasks = arr(&ws["tasks"]); let subs = arr(&ws["submissions"]);
    let mut out = String::new();
    if let Some((ok, m)) = flash { out += &format!("<div class=\"card {}\" role=\"status\">{}</div>", if ok { "ok" } else { "err" }, esc(&m)); }
    if let Some(r) = result { out += &r; }

    out += "<div class=\"card\"><h2>Projets</h2><ul>";
    for p in &projects { out += &format!("<li><strong>{}</strong> — {} — {} {}</li>", esc(&s_(p, "title")), esc(&s_(p, "status")), esc(&s_(p, "budget_amount")), esc(&s_(p, "budget_currency"))); }
    out += "</ul></div>";
    if role == "org_client" || op {
        out += &format!("<div class=\"card\"><h2>Nouveau projet</h2><form method=\"post\" action=\"/business/create_project\">{hidden}\
<label>Organisation<input name=\"organizationName\" required maxlength=\"200\"></label><label>Titre<input name=\"title\" required minlength=\"3\" maxlength=\"200\"></label>\
<label>Description<textarea name=\"description\" required minlength=\"10\" maxlength=\"10000\"></textarea></label>\
<label>Type<select name=\"projectType\">{}</select></label>\
<label>Langues cibles (séparées par des virgules)<input name=\"targetLanguages\" required></label><label>Dialectes<input name=\"targetDialects\"></label>\
<label>Budget<input name=\"budgetAmount\" type=\"number\" min=\"0\" required></label><label>Devise<input name=\"budgetCurrency\" value=\"XOF\" maxlength=\"3\"></label>\
<label>Échéance<input name=\"deadline\" type=\"date\"></label><button>Soumettre</button></form></div>",
            sel(&["TRANSCRIPTION", "TRANSLATION", "VOICE_DATASET", "DATA_ANNOTATION", "QUALITY_EVALUATION", "LOCALIZATION"]));
    }
    if role == "contributor" || role == "reviewer" || op {
        out += &format!("<div class=\"card\"><h2>Profil talent</h2><form method=\"post\" action=\"/business/upsert_talent_profile\">{hidden}\
<label>Accroche<input name=\"headline\" required maxlength=\"200\"></label><label>Pays<input name=\"country\" required maxlength=\"64\"></label>\
<label>Langues maternelles<input name=\"nativeLanguages\" required></label><label>Autres langues<input name=\"otherLanguages\"></label>\
<label>Dialectes<input name=\"dialects\"></label><label>Compétences<input name=\"skills\"></label>\
<label>Disponibilité<select name=\"availability\">{}</select></label><label>Heures / semaine<input name=\"weeklyHours\" type=\"number\" min=\"0\" max=\"80\" value=\"10\"></label>\
<label><input type=\"checkbox\" name=\"consentVoiceDataset\" value=\"true\"> Consentement voix</label><button>Enregistrer</button></form></div>",
            sel(&["AVAILABLE", "PARTIALLY_AVAILABLE", "UNAVAILABLE"]));
    }
    if op {
        let popts = options(&projects, |p| s_(p, "title"));
        let dir = arr(&ws["talentDirectory"]);
        let topts = options(&dir.iter().map(|t| t.get("user").cloned().unwrap_or_else(|| t.clone())).collect::<Vec<_>>(), |x| format!("{} ({})", s_(x, "full_name"), s_(x, "role")));
        out += &format!("<div class=\"card\"><h2>Revue de projet</h2><form method=\"post\" action=\"/business/review_project\">{hidden}\
<label>Projet<select name=\"projectId\">{popts}</select></label><label>Statut<select name=\"newStatus\">{}</select></label>\
<label>Notes<textarea name=\"operatorNotes\" maxlength=\"5000\"></textarea></label><button>Appliquer</button></form></div>",
            sel(&["UNDER_REVIEW", "APPROVED_ACTIVE", "IN_EXECUTION", "QUALITY_REVIEW", "CANCELLED"]));
        out += &format!("<div class=\"card\"><h2>Matching de talents</h2><form method=\"get\" action=\"/business/matches\">\
<label>Projet<select name=\"projectId\">{popts}</select></label><button>Classer les talents</button></form></div>");
        out += &format!("<div class=\"card\"><h2>Évaluation de talent</h2><form method=\"post\" action=\"/business/record_assessment\">{hidden}\
<label>Talent (id)<input name=\"talentUserId\" required list=\"talents\"></label><datalist id=\"talents\">{topts}</datalist>\
<label>Type<select name=\"assessmentType\">{}</select></label><label>Langue<input name=\"languageCode\"></label>\
<label>Compétence<input name=\"skillName\" required></label><label>Score<input name=\"score\" type=\"number\" min=\"0\" max=\"100\" required></label><button>Enregistrer</button></form></div>",
            sel(&["LANGUAGE_PROFICIENCY", "DOMAIN_SKILL", "TRANSCRIPTION_TEST", "TRANSLATION_TEST"]));
        out += &format!("<div class=\"card\"><h2>Créer et assigner une tâche</h2><form method=\"post\" action=\"/business/create_assign_task\">{hidden}\
<label>Projet<select name=\"projectId\">{popts}</select></label><label>Titre<input name=\"title\" required></label>\
<label>Instructions<textarea name=\"instructions\" required></textarea></label><label>Langue<input name=\"languageCode\" required></label>\
<label>Contributeur (id)<input name=\"assignedContributorId\" required list=\"talents\"></label><label>Relecteur (id)<input name=\"assignedReviewerId\" list=\"talents\"></label>\
<label>Fichier source (id)<input name=\"sourceFileId\"></label><label>Rémunération (centimes, simulée)<input name=\"compensationCents\" type=\"number\" min=\"0\" required></label>\
<button>Assigner</button></form></div>");
        out += &format!("<div class=\"card\"><h2>Livraison finale</h2><form method=\"post\" action=\"/business/finalize_delivery\">{hidden}\
<label>Projet<select name=\"projectId\">{popts}</select></label><label>Titre<input name=\"title\" required></label>\
<label>Synthèse<textarea name=\"executiveSummary\" required></textarea></label><button>Finaliser</button></form></div>");
        out += &format!("<div class=\"card\"><h2>Rémunérations (sandbox — aucun virement réel)</h2><form method=\"post\" action=\"/business/update_compensation\">{hidden}\
<label>Rémunération<select name=\"compensationId\">{}</select></label><label>Statut<select name=\"newStatus\">{}</select></label><button>Mettre à jour</button></form></div>",
            options(&arr(&ws["compensations"]), |c| format!("{} — {} — {}", s_(c, "task_title"), s_(c, "contributor_name"), s_(c, "payment_status"))),
            sel(&["PENDING", "APPROVED", "READY_FOR_PAYOUT", "PAID_SIMULATED", "CANCELLED"]));
    }
    out += "<div class=\"card\"><h2>Tâches</h2><ul>";
    for t in &tasks {
        let src = s_(t, "source_file_id");
        let link = if src.is_empty() { String::new() } else { format!(" — <a href=\"/api/files/{}\">fichier source</a>", esc(&src)) };
        out += &format!("<li><strong>{}</strong> — {} — {}{link}</li>", esc(&s_(t, "title")), esc(&s_(t, "language_code")), esc(&s_(t, "status")));
    }
    out += "</ul></div>";
    if role == "contributor" || op {
        let mine: Vec<Value> = tasks.iter().filter(|t| s_(t, "assigned_contributor_id") == u.id).cloned().collect();
        if !mine.is_empty() {
            out += &format!("<div class=\"card\"><h2>Soumettre un livrable</h2><form method=\"post\" action=\"/business/submit_work\">{hidden}\
<label>Tâche<select name=\"taskId\">{}</select></label><label>Contenu<textarea name=\"contentText\" required minlength=\"3\" maxlength=\"100000\"></textarea></label>\
<label>Notes<textarea name=\"notes\" maxlength=\"5000\"></textarea></label><button>Soumettre</button></form></div>", options(&mine, |t| s_(t, "title")));
        }
    }
    if role == "reviewer" || op {
        // never offer one's own deliverable for review (the Java service also refuses it with 403 + audit)
        let reviewable: Vec<Value> = subs.iter().filter(|x| s_(x, "status") == "SUBMITTED" && s_(x, "contributor_user_id") != u.id).cloned().collect();
        out += &format!("<div class=\"card\"><h2>Relecture</h2>{}</div>", if reviewable.is_empty() { "<p>Aucun livrable à relire.</p>".to_string() } else { format!(
            "<form method=\"post\" action=\"/business/review_submission\">{hidden}<label>Livrable<select name=\"submissionId\">{}</select></label>\
<label>Décision<select name=\"decision\">{}</select></label><label>Qualité<input name=\"qualityScore\" type=\"number\" min=\"0\" max=\"100\" required></label>\
<label>Précision<input name=\"accuracyScore\" type=\"number\" min=\"0\" max=\"100\"></label><label>Commentaire<textarea name=\"feedback\" required minlength=\"3\"></textarea></label><button>Relire</button></form>",
            options(&reviewable, |x| format!("{} — v{} — {}", s_(x, "task_title"), s_(x, "revision_number"), s_(x, "contributor_name"))), sel(&["APPROVE", "REQUEST_REVISION", "REJECT"])) });
    }
    out += "<div class=\"card\"><h2>Rapports de livraison</h2><ul>";
    for r in arr(&ws["deliveryReports"]) { out += &format!("<li>{} — {} — qualité moyenne {}</li>", esc(&s_(&r, "project_title")), esc(&s_(&r, "title")), esc(&s_(&r, "average_quality_score"))); }
    out += "</ul></div>";
    Ok(crate::ui::page("SOLOB Business", &format!("<div class=\"card\"><h1>SOLOB Business</h1><p>Espace de {} ({}). Paiements : sandbox uniquement, aucun virement réel.</p></div>{out}", esc(&u.full_name), esc(&u.role))))
}

pub async fn ui_business(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    match session(&s, &hm).await {
        Ok((u, tok)) => Ok(html(200, render(&s, &u, &tok, None, None).await?)),
        Err(e) => Ok(html(e.status, crate::ui::pillar("SOLOB Business", None, Some(e.message)))),
    }
}

fn list(f: &HashMap<String, String>, k: &str) -> Value {
    json!(f.get(k).map(|v| v.split(',').map(|x| x.trim()).filter(|x| !x.is_empty()).map(String::from).collect::<Vec<_>>()).unwrap_or_default())
}
fn opt(f: &HashMap<String, String>, k: &str) -> Value { f.get(k).filter(|v| !v.trim().is_empty()).map(|v| json!(v.trim())).unwrap_or(Value::Null) }
fn num(f: &HashMap<String, String>, k: &str) -> Value { f.get(k).and_then(|v| v.trim().parse::<f64>().ok()).map(|n| json!(n)).unwrap_or(Value::Null) }

const ACTIONS: &[&str] = &["create_project", "review_project", "upsert_talent_profile", "record_assessment", "create_assign_task",
    "submit_work", "review_submission", "finalize_delivery", "update_compensation"];

pub async fn ui_business_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                                axum::Form(f): axum::Form<HashMap<String, String>>) -> Result<Response, AppError> {
    if !ACTIONS.contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Unknown Business action.")); }
    let (u, tok) = session(&s, &hm).await?;
    let csrf = f.get("csrf").map(String::as_str).unwrap_or("");
    h::enforce_csrf(&Method::POST, &hm, Some(csrf))?;
    if !crypto::verify_csrf_token(&s.cfg.session_secret, &tok, csrf) { return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); }
    rate_limit::enforce(&s.pool, &format!("business:mutation:user:{}", u.id), 60, 60_000).await?;
    let mut body = serde_json::Map::new();
    for (k, v) in &f { if k != "csrf" { body.insert(k.clone(), opt(&f, k)); let _ = v; } }
    for k in ["targetLanguages", "targetDialects", "nativeLanguages", "otherLanguages", "dialects", "skills"] { if f.contains_key(k) { body.insert(k.into(), list(&f, k)); } }
    for k in ["budgetAmount", "weeklyHours", "score", "compensationCents", "qualityScore", "accuracyScore"] { if f.contains_key(k) { body.insert(k.into(), num(&f, k)); } }
    if action == "upsert_talent_profile" { body.insert("consentVoiceDataset".into(), json!(f.get("consentVoiceDataset").map(|v| v == "true").unwrap_or(false))); }
    body.insert("action".into(), json!(action));
    let (st, v) = business_call(&s, &u, reqwest::Method::POST, "actions", Some(Value::Object(body))).await?;
    let ok = (200..300).contains(&st);
    let msg = if ok { "Action effectuée.".to_string() } else { format!("Erreur {} : {}", s_(&v["error"], "code"), s_(&v["error"], "message")) };
    Ok(html(if ok { 200 } else { st }, render(&s, &u, &tok, Some((ok, msg)), None).await?))
}

/// GET /business/matches?projectId=… — read-only ranking page (operator/admin enforced by Java).
pub async fn ui_business_matches(State(s): State<AppState>, hm: HeaderMap, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>) -> Result<Response, AppError> {
    let (u, tok) = session(&s, &hm).await?;
    let pid = q.get("projectId").cloned().unwrap_or_default();
    if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Err(AppError::new(400, "INVALID_PROJECT_ID", "Invalid project id.")); }
    let (st, v) = business_call(&s, &u, reqwest::Method::GET, &format!("matches/{pid}"), None).await?;
    if !(200..300).contains(&st) {
        let msg = format!("Erreur {} : {}", s_(&v["error"], "code"), s_(&v["error"], "message"));
        return Ok(html(st, render(&s, &u, &tok, Some((false, msg)), None).await?));
    }
    let mut card = String::from("<div class=\"card\"><h2>Classement des talents</h2><table><tr><th>Talent</th><th>Score</th><th>Éligible</th><th>Raisons</th></tr>");
    for c in arr(&v["candidates"]) {
        let reasons: String = arr(&c["explanationReasons"]).iter().map(|r| format!("<li>{}</li>", esc(r.as_str().unwrap_or("")))).collect();
        card += &format!("<tr><td>{} <small>{}</small></td><td>{}</td><td>{}</td><td><ul>{reasons}</ul></td></tr>", esc(&s_(&c, "fullName")), esc(&s_(&c, "userId")),
            esc(&s_(&c, "matchScore")), if c["eligibleForVerifiedAssignment"].as_bool() == Some(true) { "oui" } else { "non (langue non vérifiée)" });
    }
    card += "</table></div>";
    Ok(html(200, render(&s, &u, &tok, None, Some(card)).await?))
}
