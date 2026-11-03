//! SOLOB School server-rendered forms (no JavaScript). Each form posts to the gateway, which checks the session,
//! the CSRF form token (double-submit + HMAC binding to the session), RBAC and the mutation rate limit, then calls
//! the internal Python School service with the trusted identity headers.
use crate::{app::AppState, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Calls the School service; returns (status, json body). Never forwards the browser's own headers.
pub async fn school_call(s: &AppState, u: &rbac::AuthUser, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(u16, Value), AppError> {
    let url = format!("{}/{}", s.cfg.school_url.trim_end_matches('/'), path);
    let mut rb = s.http.request(method, &url)
        .header("x-solob-service-secret", &s.cfg.service_secret)
        .header("x-solob-user-id", &u.id).header("x-solob-user-role", &u.role).header("x-solob-user-email", &u.email)
        .timeout(std::time::Duration::from_secs(20));
    if let Some(b) = body { rb = rb.json(&b); }
    let r = rb.send().await.map_err(|e| { eprintln!("upstream school error: {e}");
        AppError::new(502, "UPSTREAM_UNAVAILABLE", "SOLOB school service is unavailable.") })?;
    let st = r.status().as_u16();
    Ok((st, r.json::<Value>().await.unwrap_or(Value::Null)))
}

async fn session(s: &AppState, hm: &HeaderMap) -> Result<(rbac::AuthUser, String), AppError> {
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), rbac::SCHOOL_ROLES, "school", "UI")?;
    Ok((u.unwrap(), tok.unwrap()))
}

fn check_form_csrf(s: &AppState, hm: &HeaderMap, tok: &str, csrf: &str) -> Result<(), AppError> {
    h::enforce_csrf(&Method::POST, hm, Some(csrf))?;
    if !crypto::verify_csrf_token(&s.cfg.session_secret, tok, csrf) {
        return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token."));
    }
    Ok(())
}

fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn s_(v: &Value, k: &str) -> String { match v.get(k) { Some(Value::String(x)) => x.clone(), Some(Value::Null) | None => String::new(), Some(x) => x.to_string() } }

fn options(items: &Value, label: &str, selected: &str) -> String {
    items.as_array().map(|a| a.iter().map(|i| { let id = s_(i, "id");
        format!("<option value=\"{}\"{}>{}</option>", esc(&id), if id == selected { " selected" } else { "" }, esc(&s_(i, label))) }).collect()).unwrap_or_default()
}

pub async fn render(s: &AppState, u: &rbac::AuthUser, tok: &str, flash: Option<(bool, String)>, result: Option<String>) -> Result<String, AppError> {
    let csrf = esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok));
    let (_, cat) = school_call(s, u, reqwest::Method::GET, "catalog", None).await?;
    let (_, ws) = school_call(s, u, reqwest::Method::GET, "workspace", None).await?;
    let prof = ws.get("profile").cloned().unwrap_or(Value::Null);
    let hidden = format!("<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">");
    let docs = options(&ws["documents"], "title", "");
    let doc_sel = format!("<label>Document source<select name=\"documentId\"><option value=\"\">— aucun —</option>{docs}</select></label>");
    let subj = options(&cat["subjects"], "name", &s_(&prof, "primary_subject_id"));
    let mut out = String::new();
    if let Some((ok, m)) = flash { out += &format!("<div class=\"card {}\" role=\"status\">{}</div>", if ok { "ok" } else { "err" }, esc(&m)); }
    if let Some(r) = result { out += &r; }
    let ps = &ws["progressSummary"];
    out += &format!("<div class=\"card\"><h2>Progression</h2><p>Activités : {} · Documents : {} · Exercices notés : {} · Moyenne : {} % · Progression cumulée : {}/100</p></div>",
        esc(&s_(ps, "totalActivities")), esc(&s_(ps, "documentsUploaded")), esc(&s_(ps, "exercisesCompleted")), esc(&s_(ps, "averageScorePercentage")), esc(&s_(ps, "cumulativeProgressScore")));
    out += &format!("<div class=\"card\"><h2>Profil académique</h2><form method=\"post\" action=\"/school/profile\">{hidden}\
<label>Pays<input name=\"country\" value=\"{}\" required maxlength=\"64\"></label>\
<label>Programme<select name=\"curriculumId\">{}</select></label><label>Niveau<select name=\"levelId\">{}</select></label>\
<label>Matière principale<select name=\"primarySubjectId\">{subj}</select></label>\
<label>Établissement<input name=\"institutionName\" value=\"{}\" maxlength=\"200\"></label><button>Enregistrer</button></form></div>",
        esc(&s_(&prof, "country")), options(&cat["curricula"], "name", &s_(&prof, "curriculum_id")), options(&cat["levels"], "name", &s_(&prof, "level_id")),
        esc(&s_(&prof, "institution_name")));
    let teacher = if u.role == "teacher" || u.role == "admin" { "<label><input type=\"checkbox\" name=\"isTeacherResource\" value=\"true\"> Ressource enseignant (visible par les élèves)</label>" } else { "" };
    out += &format!("<div class=\"card\"><h2>Déposer un document de cours</h2><p>Formats : txt, md, csv, json, pdf, wav, mp3 — 10 Mo max. Les exécutables et scripts sont refusés.</p>\
<form method=\"post\" action=\"/school/upload\" enctype=\"multipart/form-data\">{hidden}<label>Titre<input name=\"title\" required minlength=\"2\" maxlength=\"200\"></label>\
<label>Matière<select name=\"subjectId\"><option value=\"\">—</option>{subj}</select></label><label>Fichier<input type=\"file\" name=\"file\" required></label>{teacher}<button>Déposer</button></form></div>");
    out += &format!("<div class=\"card\"><h2>Explication sourcée</h2><form method=\"post\" action=\"/school/explain\">{hidden}\
<label>Question<textarea name=\"question\" required minlength=\"3\" maxlength=\"12000\"></textarea></label>{doc_sel}<button>Expliquer</button></form></div>");
    let mts: String = ["SUMMARY", "FLASHCARDS", "QUIZ", "EXAM_PREP", "FACT_CHECK", "TEACHER_ASSESSMENT"].iter().map(|m| format!("<option>{m}</option>")).collect();
    out += &format!("<div class=\"card\"><h2>Révision et exercice</h2><form method=\"post\" action=\"/school/generate\">{hidden}\
<label>Titre<input name=\"title\" required minlength=\"2\" maxlength=\"200\"></label>{doc_sel}<label>Type<select name=\"materialType\">{mts}</select></label>\
<label>Difficulté<select name=\"difficulty\"><option>FOUNDATION</option><option selected>INTERMEDIATE</option><option>EXAM_LEVEL</option></select></label><button>Générer</button></form></div>");
    out += "<div class=\"card\"><h2>Exercices</h2>";
    for ex in ws["exercises"].as_array().cloned().unwrap_or_default() {
        out += &format!("<form method=\"post\" action=\"/school/submit\">{hidden}<input type=\"hidden\" name=\"exerciseId\" value=\"{}\"><h3>{} ({})</h3>",
            esc(&s_(&ex, "id")), esc(&s_(&ex, "title")), esc(&s_(&ex, "difficulty")));
        for q in ex["questions_json"].as_array().cloned().unwrap_or_default() {
            out += &format!("<label>{} <small>/{}</small><textarea name=\"answer_{}\" maxlength=\"20000\"></textarea></label>",
                esc(&s_(&q, "prompt")), esc(&s_(&q, "maxPoints")), esc(&s_(&q, "id")));
        }
        out += "<button>Soumettre pour correction</button></form>";
    }
    out += "</div><div class=\"card\"><h2>Corrections</h2><ul>";
    for sb in ws["submissions"].as_array().cloned().unwrap_or_default().iter().take(10) {
        out += &format!("<li><strong>{}</strong> — {} / {} — {}</li>", esc(&s_(sb, "exercise_title")), esc(&s_(sb, "score")), esc(&s_(sb, "max_score")), esc(&s_(sb, "overall_feedback")));
    }
    out += "</ul></div>";
    Ok(crate::ui::page("SOLOB School", &format!("<div class=\"card\"><h1>SOLOB School</h1><p>Espace strictement académique de {} ({}). Mode IA : démonstration déterministe (aucun fournisseur externe).</p></div>{out}", esc(&u.full_name), esc(&u.role))))
}

pub async fn ui_school(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    match session(&s, &hm).await {
        Ok((u, tok)) => Ok(html(200, render(&s, &u, &tok, None, None).await?)),
        Err(e) => Ok(html(e.status, crate::ui::pillar("SOLOB School", None, Some(e.message)))),
    }
}

fn opt(f: &HashMap<String, String>, k: &str) -> Value { f.get(k).filter(|v| !v.trim().is_empty()).map(|v| json!(v)).unwrap_or(Value::Null) }

/// Réponses du fournisseur expérimental solob-local : bandeau EXPÉRIMENTAL + brouillon du modèle clairement séparé.
/// Le petit modèle (~3,4 M paramètres) ne produit pas de réponses pédagogiques fiables.
fn experimental_block(ai: &Value) -> String {
    let local = ai["experimental"].as_bool() == Some(true) || s_(ai, "provider") == "solob-local";
    if !local { return String::new(); }
    let draft = s_(&ai["data"], "localModelDraft");
    format!("<div class=\"card warn\" role=\"note\"><p><strong>EXPÉRIMENTAL — brouillon du petit modèle SOLOB AI (solob-local), non évalué.</strong> \
Ce texte n'est pas une réponse fiable ; seules les citations extraites du document le sont.</p><p><small>{}</small></p>\
<details><summary>Brouillon brut du modèle (expérimental)</summary><pre>{}</pre></details></div>", esc(&s_(ai, "epistemicNotice")), esc(&draft))
}

fn result_card(action: &str, v: &Value, hidden: &str) -> Option<String> {
    match action {
        "explain" => { let d = &v["aiResult"]["data"];
            let tk: String = d["keyTakeaways"].as_array().map(|a| a.iter().map(|t| format!("<li>{}</li>", esc(t.as_str().unwrap_or("")))).collect()).unwrap_or_default();
            let mid = s_(&v["material"], "id");
            let fb = if mid.is_empty() { String::new() } else { format!("<form method=\"post\" action=\"/school/feedback\">{hidden}<input type=\"hidden\" name=\"materialId\" value=\"{}\">\
<label>Commentaire (facultatif)<textarea name=\"comment\" maxlength=\"2000\"></textarea></label>\
<button name=\"helpful\" value=\"true\">Réponse utile</button> <button name=\"helpful\" value=\"false\">Pas utile</button></form>", esc(&mid)) };
            let xp = experimental_block(&v["aiResult"]);
            Some(format!("<div class=\"card\"><h2>Explication (incertitude {})</h2>{xp}<pre>{}</pre><ul>{tk}</ul>{fb}</div>", esc(&s_(&v["aiResult"], "uncertaintyLevel")), esc(&s_(d, "explanation")))) }
        "feedback" => Some("<div class=\"card ok\"><p>Merci : votre avis aide à améliorer SOLOB AI.</p></div>".to_string()),
        "generate" => { let c = &v["studyMaterial"]["content_json"];
            let fc: String = c["flashcards"].as_array().map(|a| a.iter().map(|f| format!("<li><strong>{}</strong> : {}</li>", esc(&s_(f, "front")), esc(&s_(f, "back")))).collect()).unwrap_or_default();
            Some(format!("<div class=\"card\"><h2>Fiche de révision</h2><p>{}</p><ul>{fc}</ul></div>", esc(&s_(c, "summary")))) }
        "submit" => { let sb = &v["submission"];
            let cs: String = sb["corrections_json"].as_array().map(|a| a.iter().map(|c| format!("<li>{} : {}/{} — {}</li>", esc(&s_(c, "questionId")), esc(&s_(c, "awardedPoints")), esc(&s_(c, "maxPoints")), esc(&s_(c, "explanation")))).collect()).unwrap_or_default();
            Some(format!("<div class=\"card\"><h2>Correction : {}/{} ({} %)</h2><p>{}</p><ul>{cs}</ul><p><small>{}</small></p></div>",
                esc(&s_(sb, "score")), esc(&s_(sb, "max_score")), esc(&s_(sb, "percentage")), esc(&s_(sb, "overall_feedback")), esc(&s_(sb, "uncertainty_note")))) }
        _ => None,
    }
}

async fn finish(s: &AppState, u: &rbac::AuthUser, tok: &str, action: &str, st: u16, v: Value) -> Result<Response, AppError> {
    let ok = (200..300).contains(&st);
    let msg = if ok { "Action effectuée.".to_string() } else {
        format!("Erreur {} : {}", s_(&v["error"], "code"), s_(&v["error"], "message")) };
    let hid = format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)));
    let res = if ok { result_card(action, &v, &hid) } else { None };
    Ok(html(if ok { 200 } else { st }, render(s, u, tok, Some((ok, msg)), res).await?))
}

async fn pre(s: &AppState, hm: &HeaderMap, csrf: &str) -> Result<(rbac::AuthUser, String), AppError> {
    let (u, tok) = session(s, hm).await?;
    check_form_csrf(s, hm, &tok, csrf)?;
    rate_limit::enforce(&s.pool, &format!("school:mutation:user:{}", u.id), 60, 60_000).await?;
    Ok((u, tok))
}

/// Urlencoded School forms: profile, explain, generate, submit, feedback (« réponse utile »).
pub async fn ui_school_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                              axum::Form(f): axum::Form<HashMap<String, String>>) -> Result<Response, AppError> {
    let (u, tok) = pre(&s, &hm, f.get("csrf").map(String::as_str).unwrap_or("")).await?;
    let (path, body) = match action.as_str() {
        "profile" => ("profile", json!({"country": f.get("country"), "curriculumId": f.get("curriculumId"), "levelId": f.get("levelId"),
                        "primarySubjectId": f.get("primarySubjectId"), "institutionName": opt(&f, "institutionName")})),
        "explain" => ("explanations", json!({"question": f.get("question"), "documentId": opt(&f, "documentId")})),
        "generate" => ("revisions", json!({"title": f.get("title"), "documentId": opt(&f, "documentId"),
                        "materialType": opt(&f, "materialType"), "difficulty": opt(&f, "difficulty")})),
        "submit" => { let answers: serde_json::Map<String, Value> = f.iter().filter_map(|(k, v)| k.strip_prefix("answer_").map(|q| (q.to_string(), json!(v)))).collect();
                      ("submissions", json!({"exerciseId": f.get("exerciseId"), "answers": answers})) }
        "feedback" => ("feedback", json!({"materialId": f.get("materialId"), "helpful": f.get("helpful").map(|v| v == "true"), "comment": f.get("comment").cloned().unwrap_or_default()})),
        _ => return Err(AppError::new(404, "UNKNOWN_ACTION", "Unknown School action.")),
    };
    let (st, v) = school_call(&s, &u, reqwest::Method::POST, path, Some(body)).await?;
    finish(&s, &u, &tok, &action, st, v).await
}

/// Multipart upload form → JSON (base64) to the School service, which applies the TS size/type/signature rules.
pub async fn ui_school_upload(State(s): State<AppState>, hm: HeaderMap, mut mp: Multipart) -> Result<Response, AppError> {
    let bad = |m: &str| AppError::new(400, "INVALID_MULTIPART", m);
    let mut fields: HashMap<String, String> = HashMap::new();
    let (mut file, mut fname, mut fmime) = (None::<Vec<u8>>, String::new(), None::<String>);
    while let Some(field) = mp.next_field().await.map_err(|_| bad("Malformed multipart body."))? {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            fname = field.file_name().unwrap_or("").to_string();
            fmime = field.content_type().map(String::from);
            file = Some(field.bytes().await.map_err(|_| AppError::new(413, "FILE_TOO_LARGE", "Upload too large or interrupted."))?.to_vec());
        } else if fields.len() < 10 {
            fields.insert(name, field.text().await.map_err(|_| bad("Malformed field."))?);
        }
    }
    let (u, tok) = pre(&s, &hm, fields.get("csrf").map(String::as_str).unwrap_or("")).await?;
    let data = file.unwrap_or_default();
    let body = json!({"title": fields.get("title").cloned().unwrap_or_default(), "originalFileName": fname, "mimeType": fmime,
        "contentBase64": base64::engine::general_purpose::STANDARD.encode(&data), "subjectId": opt(&fields, "subjectId"),
        "isTeacherResource": fields.get("isTeacherResource").map(|v| v == "true").unwrap_or(false)});
    let (st, v) = school_call(&s, &u, reqwest::Method::POST, "documents", Some(body)).await?;
    finish(&s, &u, &tok, "upload", st, v).await
}

#[cfg(test)]
mod experimental_tests {
    use super::*;
    #[test]
    fn local_provider_answers_are_labelled_experimental() {
        let v = json!({"aiResult": {"provider": "solob-local", "experimental": true, "uncertaintyLevel": "HIGH", "epistemicNotice": "[EXPERIMENTAL]",
            "data": {"explanation": "x", "keyTakeaways": [], "localModelDraft": "<b>draft</b>"}}, "material": {"id": ""}});
        let h = result_card("explain", &v, "").unwrap();
        assert!(h.contains("EXPÉRIMENTAL")); assert!(h.contains("&lt;b&gt;draft")); assert!(!h.contains("<b>draft"));
        let demo = json!({"aiResult": {"provider": "mock", "uncertaintyLevel": "LOW", "data": {"explanation": "x"}}, "material": {"id": ""}});
        assert!(!result_card("explain", &demo, "").unwrap().contains("EXPÉRIMENTAL"));
    }
}
