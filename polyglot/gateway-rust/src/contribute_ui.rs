//! Contributions des utilisateurs à SOLOB AI (/contribute), rendues côté serveur, sans JavaScript (CSP stricte inchangée).
//! Pipeline: session → RBAC → CSRF HMAC lié à la session → limitation de débit atomique PostgreSQL → écriture auditée.
//! Chaque contribution exige un consentement explicite (texte versionné, licence CC BY 4.0) et crée un item de la
//! double relecture de la migration 005 (deux relecteurs habilités DISTINCTS, auto-relecture refusée par trigger).
//! Nécessite db/migrations-ai/005 puis 006 (opt-in); sans elles les pages répondent 503 « module non activé ».
use crate::{app::AppState, audit, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{extract::{Path, State}, http::{header, HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}};
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;

pub const LANGUAGES: &[&str] = &["fon", "yo", "ha", "wo", "ig", "sw", "fr", "en"];
pub const KINDS: &[&str] = &["text", "translation", "correction"];
pub const REPORT_REASONS: &[&str] = &["toxic", "plagiarism", "personal_data", "spam", "wrong_language", "other"];
pub const CONSENT_VERSION: &str = "contrib-v1";
/// Soumissions par utilisateur et par heure (anti-spam), en plus de 30 actions/minute.
pub const SUBMIT_PER_HOUR: i32 = 10;
const TITLE: &str = "SOLOB AI — Contribuer";

fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}
fn err_page(e: AppError) -> Response {
    html(e.status, crate::ui::page(TITLE, &format!("<div class=\"card\"><h1>{TITLE}</h1><p class=\"err\">{}</p><p><a href=\"/contribute\">Retour</a></p></div>", esc(&e.message))))
}

/// Filtre de contenu minimal (avant relecture humaine): données personnelles évidentes, liens en masse, caractères de contrôle.
pub fn content_issue(t: &str) -> Option<&'static str> {
    if t.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') { return Some("Caractères de contrôle interdits."); }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.iter().any(|w| { let w = w.trim_matches(|c: char| !c.is_alphanumeric()); w.contains('@') && w.split('@').nth(1).map_or(false, |d| d.contains('.')) }) {
        return Some("Le texte semble contenir une adresse email (donnée personnelle).");
    }
    let mut run = 0; let mut max_run = 0;
    for c in t.chars() { if c.is_ascii_digit() { run += 1; max_run = max_run.max(run) } else if !matches!(c, ' ' | '-' | '.' | '+') { run = 0 } }
    if max_run >= 8 { return Some("Le texte semble contenir un numéro de téléphone ou d'identification (donnée personnelle)."); }
    if words.iter().filter(|w| w.contains("http://") || w.contains("https://") || w.starts_with("www.")).count() > 2 { return Some("Trop de liens (spam)."); }
    None
}

async fn module_enabled(s: &AppState) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar("SELECT to_regclass('public.contributions') IS NOT NULL AND to_regclass('public.ai_reviews') IS NOT NULL").fetch_one(&s.pool).await?;
    if ok { Ok(()) } else { Err(AppError::new(503, "CONTRIB_MODULE_DISABLED", "Module de contributions non activé (migrations 005/006 non appliquées).")) }
}
async fn session(s: &AppState, hm: &HeaderMap) -> Result<(rbac::AuthUser, String), AppError> {
    module_enabled(s).await?;
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), rbac::ALL_ROLES, "core", "AI_CONTRIBUTE")?;
    Ok((u.unwrap(), tok.unwrap()))
}
fn hidden(s: &AppState, tok: &str) -> String {
    format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)))
}
fn opts(list: &[&str]) -> String { list.iter().map(|x| format!("<option value=\"{0}\">{0}</option>", esc(x))).collect() }

pub async fn ui_contribute(State(s): State<AppState>, hm: HeaderMap) -> Response {
    match render(&s, &hm, None).await { Ok(b) => html(200, b), Err(e) => err_page(e) }
}

async fn render(s: &AppState, hm: &HeaderMap, flash: Option<String>) -> Result<String, AppError> {
    let (u, tok) = session(s, hm).await?;
    let hid = hidden(s, &tok);
    let consent: String = sqlx::query_scalar("SELECT body FROM contribution_consent_texts WHERE version=$1").bind(CONSENT_VERSION).fetch_one(&s.pool).await?;
    let points: i32 = sqlx::query_scalar("SELECT COALESCE((SELECT points FROM contributor_reputation WHERE user_id=$1),0)").bind(&u.id).fetch_one(&s.pool).await?;
    let mut out = flash.map(|m| format!("<div class=\"card ok\" role=\"status\">{}</div>", esc(&m))).unwrap_or_default();
    out += &format!("<div class=\"card\"><h2>Proposer un texte, une traduction ou une correction</h2>\
<form method=\"post\" action=\"/contribute/submit\">{hid}\
<label>Type<select name=\"kind\">{}</select></label><label>Langue<select name=\"language\">{}</select></label>\
<label>Texte source (obligatoire pour une traduction ou une correction)<textarea name=\"source_text\" maxlength=\"4000\"></textarea></label>\
<label>Votre contribution (10 à 8000 caractères)<textarea name=\"body\" required minlength=\"10\" maxlength=\"8000\"></textarea></label>\
<label>Attribution (nom ou pseudonyme publié avec la licence)<input name=\"attribution\" required maxlength=\"120\"></label>\
<fieldset><legend>Consentement ({v}, licence CC BY 4.0)</legend><p>{}</p>\
<label><input type=\"checkbox\" name=\"consent\" value=\"{v}\" required> J'accepte ce texte de consentement et la licence CC BY 4.0.</label>\
<label><input type=\"checkbox\" name=\"is_minor\" value=\"yes\"> J'ai moins de 18 ans.</label>\
<label><input type=\"checkbox\" name=\"parental_consent\" value=\"yes\"> (Mineurs) Un parent ou tuteur légal a donné son accord.</label></fieldset>\
<button>Envoyer pour double validation</button></form></div>", opts(KINDS), opts(LANGUAGES), esc(&consent), v = CONSENT_VERSION);
    let rows = sqlx::query("SELECT contribution_id, kind, language, status, left(body, 80) AS excerpt, used_in_training_at IS NOT NULL AS trained \
                            FROM contributions WHERE contributor_id=$1 ORDER BY created_at DESC LIMIT 50").bind(&u.id).fetch_all(&s.pool).await?;
    out += &format!("<div class=\"card\"><h2>Mes contributions</h2><p>Réputation : {points} points.</p><table><tr><th>Id</th><th>Type</th><th>Langue</th><th>Statut</th><th>Extrait</th><th></th></tr>");
    for r in &rows {
        let id: String = r.get("contribution_id"); let st: String = r.get("status");
        let wd = if (st == "pending" || st == "approved") && !r.get::<bool, _>("trained") {
            format!("<form method=\"post\" action=\"/contribute/withdraw\">{hid}<input type=\"hidden\" name=\"contribution_id\" value=\"{}\"><button>Retirer</button></form>", esc(&id))
        } else { String::new() };
        out += &format!("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{wd}</td></tr>", esc(&id), esc(&r.get::<String, _>("kind")),
            esc(&r.get::<String, _>("language")), esc(&st), esc(&r.get::<String, _>("excerpt")));
    }
    out += "</table></div>";
    out += &format!("<div class=\"card\"><h2>Signaler une contribution</h2><form method=\"post\" action=\"/contribute/report\">{hid}\
<label>Identifiant de la contribution<input name=\"contribution_id\" required maxlength=\"64\"></label><label>Motif<select name=\"reason\">{}</select></label>\
<label>Détails<textarea name=\"details\" maxlength=\"2000\"></textarea></label><button>Signaler</button></form></div>", opts(REPORT_REASONS));
    if u.role == "admin" {
        let reps = sqlx::query("SELECT report_id, contribution_id, reason, details FROM contribution_reports WHERE status='open' ORDER BY created_at LIMIT 50").fetch_all(&s.pool).await?;
        out += "<div class=\"card\"><h2>Modération : signalements ouverts</h2><table><tr><th>Signalement</th><th>Contribution</th><th>Motif</th><th>Détails</th><th></th></tr>";
        for r in &reps {
            let id: String = r.get("report_id");
            out += &format!("<tr><td>{0}</td><td>{1}</td><td>{2}</td><td>{3}</td><td><form method=\"post\" action=\"/contribute/resolve\">{hid}<input type=\"hidden\" name=\"report_id\" value=\"{0}\">\
<select name=\"decision\"><option value=\"dismissed\">Rejeter le signalement</option><option value=\"upheld\">Retenir (contribution rejetée)</option></select><button>Valider</button></form></td></tr>",
                esc(&id), esc(&r.get::<String, _>("contribution_id")), esc(&r.get::<String, _>("reason")), esc(&r.get::<String, _>("details")));
        }
        out += "</table></div>";
    }
    Ok(crate::ui::page(TITLE, &format!("<div class=\"card\"><h1>{TITLE}</h1><p>Connecté : {} ({}). Chaque contribution est relue par deux validateurs indépendants avant toute utilisation par SOLOB AI.</p><p><a href=\"/review\">File de relecture (validateurs)</a></p></div>{out}",
        esc(&u.full_name), esc(&u.role))))
}

pub async fn ui_contribute_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                                  axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["submit", "withdraw", "report", "resolve"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm).await?;
        let csrf = f.get("csrf").map(String::as_str).unwrap_or("");
        h::enforce_csrf(&Method::POST, &hm, Some(csrf))?;
        if !crypto::verify_csrf_token(&s.cfg.session_secret, &tok, csrf) { return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); }
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:contrib:{}", u.id), 30, 60_000).await?;
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let msg = match action.as_str() {
            "submit" => {
                let (kind, lang, body, src, attr) = (g("kind"), g("language"), g("body"), g("source_text"), g("attribution"));
                if g("consent") != CONSENT_VERSION {
                    audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_SUBMIT", "contribution", None, "DENIED", Some(&ip), json!({"reason": "no_consent"})).await;
                    return Err(AppError::new(400, "CONSENT_REQUIRED", "Le consentement explicite (CC BY 4.0) est obligatoire."));
                }
                let minor = g("is_minor") == "yes";
                if minor && g("parental_consent") != "yes" { return Err(AppError::new(400, "PARENTAL_CONSENT_REQUIRED", "Un mineur doit avoir l'accord d'un parent ou tuteur légal.")); }
                if !KINDS.contains(&kind.as_str()) { return Err(AppError::new(400, "INVALID_KIND", "Type invalide.")); }
                if !LANGUAGES.contains(&lang.as_str()) { return Err(AppError::new(400, "INVALID_LANGUAGE", "Langue non prise en charge.")); }
                let n = body.chars().count();
                if !(10..=8000).contains(&n) { return Err(AppError::new(400, "INVALID_BODY_LENGTH", "La contribution doit faire entre 10 et 8000 caractères.")); }
                if src.chars().count() > 4000 { return Err(AppError::new(400, "SOURCE_TOO_LONG", "Texte source trop long.")); }
                if kind != "text" && src.is_empty() { return Err(AppError::new(400, "SOURCE_REQUIRED", "Le texte source est obligatoire pour une traduction ou une correction.")); }
                let an = attr.chars().count();
                if an == 0 || an > 120 { return Err(AppError::new(400, "INVALID_ATTRIBUTION", "Attribution obligatoire (1 à 120 caractères).")); }
                if let Some(m) = content_issue(&body).or_else(|| content_issue(&src)).or_else(|| content_issue(&attr)) { return Err(AppError::new(400, "CONTENT_REJECTED", m)); }
                rate_limit::enforce(&s.pool, &format!("ui:contrib:submit:{}", u.id), SUBMIT_PER_HOUR, 3_600_000).await?;
                let sha = crypto::sha256_hex(&body);
                let cid = crypto::create_id("ctb");
                let item = format!("contrib_{cid}");
                let rk = match kind.as_str() { "text" => "resource", k => k };
                let mut tx = s.pool.begin().await?;
                let dup: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM contributions WHERE contributor_id=$1 AND body_sha256=$2)").bind(&u.id).bind(&sha).fetch_one(&mut *tx).await?;
                if dup { return Err(AppError::new(409, "DUPLICATE_CONTRIBUTION", "Vous avez déjà soumis ce texte.")); }
                let mut payload = json!({"title": format!("Contribution {kind} ({lang})"), "license": "CC-BY-4.0"});
                if kind == "translation" { payload["source_text"] = json!(src); payload["translation"] = json!(body); }
                else if kind == "correction" { payload["source_text"] = json!(src); payload["correction"] = json!(body); }
                else { payload["text"] = json!(body); }
                sqlx::query("INSERT INTO ai_review_items(item_id, kind, language, source_ref, payload, required_reviews) VALUES ($1,$2,$3,$4,$5,2)")
                    .bind(&item).bind(rk).bind(&lang).bind(format!("contrib:{cid}")).bind(&payload).execute(&mut *tx).await?;
                let prov = json!({"origin": "solob-plus-user-contribution", "channel": "gateway:/contribute", "consent_version": CONSENT_VERSION,
                                  "license": "CC-BY-4.0", "body_sha256": sha, "contributor_ref": crypto::sha256_hex(&u.id)});
                sqlx::query("INSERT INTO contributions(contribution_id, contributor_id, kind, language, source_text, body, body_sha256, attribution, consent_version, consent_at, \
                             is_minor, parental_consent_at, review_item_id, provenance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,CASE WHEN $10 THEN NOW() END,$11,$12)")
                    .bind(&cid).bind(&u.id).bind(&kind).bind(&lang).bind(if src.is_empty() { None } else { Some(&src) }).bind(&body).bind(&sha).bind(&attr)
                    .bind(CONSENT_VERSION).bind(minor).bind(&item).bind(&prov).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO contribution_consents(contribution_id, user_id, event, consent_version) VALUES ($1,$2,'GIVEN',$3)").bind(&cid).bind(&u.id).bind(CONSENT_VERSION).execute(&mut *tx).await?;
                if minor { sqlx::query("INSERT INTO contribution_consents(contribution_id, user_id, event, consent_version) VALUES ($1,$2,'PARENTAL_GIVEN',$3)").bind(&cid).bind(&u.id).bind(CONSENT_VERSION).execute(&mut *tx).await?; }
                sqlx::query("INSERT INTO ai_review_audit(actor_id, action, item_id, meta) VALUES ($1,'CONTRIBUTION_SUBMITTED',$2,$3)").bind(&u.id).bind(&item).bind(json!({"contribution_id": cid})).execute(&mut *tx).await?;
                tx.commit().await?;
                audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_SUBMIT", "contribution", Some(&cid), "SUCCESS", Some(&ip), json!({"language": lang, "kind": kind})).await;
                format!("Contribution {cid} envoyée pour double validation.")
            }
            "withdraw" => {
                let cid = g("contribution_id");
                let mut tx = s.pool.begin().await?;
                let row: Option<(String, String, bool, Option<String>)> = sqlx::query_as("SELECT contributor_id, status, used_in_training_at IS NOT NULL, review_item_id FROM contributions WHERE contribution_id=$1 FOR UPDATE")
                    .bind(&cid).fetch_optional(&mut *tx).await?;
                let Some((owner, st, trained, item)) = row else { return Err(AppError::new(404, "CONTRIBUTION_NOT_FOUND", "Contribution introuvable.")) };
                if owner != u.id {
                    audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_WITHDRAW", "contribution", Some(&cid), "DENIED", Some(&ip), json!({"reason": "not_owner"})).await;
                    return Err(AppError::new(403, "NOT_OWNER", "Vous ne pouvez retirer que vos propres contributions."));
                }
                if trained { return Err(AppError::new(409, "ALREADY_TRAINED", "Contribution déjà intégrée à un entraînement : retrait impossible.")); }
                if st != "pending" && st != "approved" { return Err(AppError::new(409, "NOT_WITHDRAWABLE", "Contribution déjà close.")); }
                sqlx::query("UPDATE contributions SET status='withdrawn', updated_at=NOW() WHERE contribution_id=$1").bind(&cid).execute(&mut *tx).await?;
                if let Some(i) = &item { sqlx::query("UPDATE ai_review_items SET status='rejected', updated_at=NOW() WHERE item_id=$1 AND status IN ('pending','in_review','disputed')").bind(i).execute(&mut *tx).await?; }
                sqlx::query("INSERT INTO contribution_consents(contribution_id, user_id, event, consent_version) SELECT $1,$2,'WITHDRAWN',consent_version FROM contributions WHERE contribution_id=$1").bind(&cid).bind(&u.id).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO ai_review_audit(actor_id, action, item_id, meta) VALUES ($1,'CONTRIBUTION_WITHDRAWN',$2,$3)").bind(&u.id).bind(&item).bind(json!({"contribution_id": cid})).execute(&mut *tx).await?;
                tx.commit().await?;
                audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_WITHDRAW", "contribution", Some(&cid), "SUCCESS", Some(&ip), json!({})).await;
                "Contribution retirée : elle ne sera jamais exportée.".to_string()
            }
            "report" => {
                let (cid, reason, details) = (g("contribution_id"), g("reason"), g("details"));
                if !REPORT_REASONS.contains(&reason.as_str()) { return Err(AppError::new(400, "INVALID_REASON", "Motif invalide.")); }
                if details.chars().count() > 2000 { return Err(AppError::new(400, "DETAILS_TOO_LONG", "Détails trop longs.")); }
                let owner: Option<String> = sqlx::query_scalar("SELECT contributor_id FROM contributions WHERE contribution_id=$1").bind(&cid).fetch_optional(&s.pool).await?;
                let Some(owner) = owner else { return Err(AppError::new(404, "CONTRIBUTION_NOT_FOUND", "Contribution introuvable.")) };
                if owner == u.id { return Err(AppError::new(400, "SELF_REPORT", "Utilisez « Retirer » pour vos propres contributions.")); }
                let res = sqlx::query("INSERT INTO contribution_reports(report_id, contribution_id, reporter_id, reason, details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (contribution_id, reporter_id) DO NOTHING")
                    .bind(crypto::create_id("rpt")).bind(&cid).bind(&u.id).bind(&reason).bind(&details).execute(&s.pool).await?;
                if res.rows_affected() == 0 { return Err(AppError::new(409, "ALREADY_REPORTED", "Vous avez déjà signalé cette contribution.")); }
                audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_REPORT", "contribution", Some(&cid), "SUCCESS", Some(&ip), json!({"reason": reason})).await;
                "Signalement enregistré. La contribution est exclue de tout export tant qu'il n'est pas traité.".to_string()
            }
            _ => { // resolve
                if u.role != "admin" {
                    audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_MODERATE", "report", None, "DENIED", Some(&ip), json!({})).await;
                    return Err(AppError::new(403, "FORBIDDEN_ROLE", "Seul un administrateur peut traiter un signalement."));
                }
                let (rid, dec) = (g("report_id"), g("decision"));
                if dec != "upheld" && dec != "dismissed" { return Err(AppError::new(400, "INVALID_DECISION", "Décision invalide.")); }
                let mut tx = s.pool.begin().await?;
                let row: Option<(String, String)> = sqlx::query_as("UPDATE contribution_reports SET status=$2, resolved_by=$3, resolved_at=NOW() WHERE report_id=$1 AND status='open' RETURNING contribution_id, reporter_id")
                    .bind(&rid).bind(&dec).bind(&u.id).fetch_optional(&mut *tx).await?;
                let Some((cid, reporter)) = row else { return Err(AppError::new(404, "REPORT_NOT_FOUND", "Signalement introuvable ou déjà traité.")) };
                if dec == "upheld" {
                    let c: (String, Option<String>) = sqlx::query_as("UPDATE contributions SET status=CASE WHEN status IN ('pending','approved') AND used_in_training_at IS NULL THEN 'rejected' ELSE status END, updated_at=NOW() \
                        WHERE contribution_id=$1 RETURNING contributor_id, review_item_id").bind(&cid).fetch_one(&mut *tx).await?;
                    if let Some(i) = &c.1 { sqlx::query("UPDATE ai_review_items SET status='rejected', updated_at=NOW() WHERE item_id=$1 AND status IN ('pending','in_review','disputed')").bind(i).execute(&mut *tx).await?; }
                    sqlx::query("INSERT INTO reputation_events(user_id, delta, reason, contribution_id) VALUES ($1,-5,'CONTRIBUTION_REPORT_UPHELD',$3),($2,2,'REPORT_UPHELD',$3)")
                        .bind(&c.0).bind(&reporter).bind(&cid).execute(&mut *tx).await?;
                }
                sqlx::query("INSERT INTO ai_review_audit(actor_id, action, item_id, meta) VALUES ($1,'REPORT_RESOLVED',NULL,$2)").bind(&u.id).bind(json!({"report_id": rid, "decision": dec, "contribution_id": cid})).execute(&mut *tx).await?;
                tx.commit().await?;
                audit::record(&s.pool, actor, "core", "AI_CONTRIBUTION_MODERATE", "report", Some(&rid), "SUCCESS", Some(&ip), json!({"decision": dec})).await;
                "Signalement traité.".to_string()
            }
        };
        render(&s, &hm, Some(msg)).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_filter() {
        assert!(content_issue("Un texte en fon tout à fait normal.").is_none());
        assert!(content_issue("Écris-moi à jean.dupont@example.org merci").is_some());
        assert!(content_issue("Appelle le +229 97 12 34 56 78").is_some());
        assert!(content_issue("http://a http://b http://c spam").is_some());
        assert!(content_issue("ligne\u{0007}bip").is_some());
        assert!(content_issue("Il y a 2026 élèves et 12 classes, @mention ok").is_none());
    }
    #[test]
    fn enums() {
        assert_eq!(LANGUAGES.len(), 8);
        assert!(KINDS.contains(&"translation"));
    }
}
