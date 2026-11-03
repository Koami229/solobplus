//! Relecture humaine des contenus SOLOB AI (/review), rendue côté serveur, sans JavaScript (CSP stricte inchangée).
//! Pipeline identique aux autres formulaires: session → RBAC (rôle + habilitation ai_reviewer_profiles) → CSRF HMAC lié
//! à la session → limitation de débit atomique PostgreSQL → écriture auditée (audit_events + ai_review_audit).
//! Double relecture en aveugle: un relecteur ne voit jamais les décisions des autres et ne peut relire qu'une fois.
//! Nécessite db/migrations-ai/005_human_review.sql (opt-in); sans elle les pages répondent 503 « module non activé ».
use crate::{app::AppState, audit, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{extract::{Path, State}, http::{header, HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}};
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub const REVIEW_ROLES: &[&str] = &["reviewer", "teacher", "admin"];
pub const DECISIONS: &[&str] = &["accept", "needs_fix", "reject"];
const TITLE: &str = "SOLOB AI — Relecture humaine";

fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}
fn err_page(e: AppError) -> Response {
    html(e.status, crate::ui::page(TITLE, &format!("<div class=\"card\"><h1>{TITLE}</h1><p class=\"err\">{}</p><p><a href=\"/review\">Retour</a></p></div>", esc(&e.message))))
}

async fn module_enabled(s: &AppState) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar("SELECT to_regclass('public.ai_reviews') IS NOT NULL").fetch_one(&s.pool).await?;
    if ok { Ok(()) } else { Err(AppError::new(503, "REVIEW_MODULE_DISABLED", "Module de relecture non activé (migration 005 non appliquée).")) }
}

/// Session + rôle autorisé. Renvoie aussi l'habilitation (langues) si elle existe et est active.
async fn session(s: &AppState, hm: &HeaderMap) -> Result<(rbac::AuthUser, String, Option<Vec<String>>), AppError> {
    module_enabled(s).await?;
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), REVIEW_ROLES, "core", "AI_REVIEW")?;
    let u = u.unwrap();
    let langs: Option<Vec<String>> = sqlx::query_scalar("SELECT languages FROM ai_reviewer_profiles WHERE user_id=$1 AND is_active")
        .bind(&u.id).fetch_optional(&s.pool).await?;
    Ok((u, tok.unwrap(), langs))
}
fn require_profile(l: &Option<Vec<String>>) -> Result<Vec<String>, AppError> {
    l.clone().ok_or_else(|| AppError::new(403, "REVIEWER_NOT_GRANTED", "Aucune habilitation de relecture IA active pour ce compte."))
}
fn check_csrf(s: &AppState, hm: &HeaderMap, tok: &str, f: &HashMap<String, String>) -> Result<(), AppError> {
    let csrf = f.get("csrf").map(String::as_str).unwrap_or("");
    h::enforce_csrf(&Method::POST, hm, Some(csrf))?;
    if !crypto::verify_csrf_token(&s.cfg.session_secret, tok, csrf) { return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); }
    Ok(())
}
fn hidden(s: &AppState, tok: &str) -> String {
    format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)))
}
fn nl2br(t: &str) -> String { esc(t).replace('\n', "<br>") }

pub async fn ui_review(State(s): State<AppState>, hm: HeaderMap) -> Response {
    match render_queue(&s, &hm, None).await { Ok(b) => html(200, b), Err(e) => err_page(e) }
}

async fn render_queue(s: &AppState, hm: &HeaderMap, flash: Option<(bool, String)>) -> Result<String, AppError> {
    let (u, tok, langs) = session(s, hm).await?;
    let mut out = flash.map(|(ok, m)| format!("<div class=\"card {}\" role=\"status\">{}</div>", if ok { "ok" } else { "err" }, esc(&m))).unwrap_or_default();
    match &langs {
        None => out += "<div class=\"card\"><p class=\"err\">Votre compte n'a pas d'habilitation de relecture IA active. Demandez-la à un administrateur.</p></div>",
        Some(l) => {
            let rows = sqlx::query("SELECT i.item_id, i.kind, i.language, i.status, i.payload->>'title' AS title FROM ai_review_items i \
                 WHERE i.status IN ('pending','in_review') AND (cardinality($2::text[]) = 0 OR i.language = ANY($2)) \
                 AND NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.item_id=i.item_id AND r.reviewer_id=$1) \
                 ORDER BY i.created_at, i.item_id LIMIT 50").bind(&u.id).bind(l).fetch_all(&s.pool).await?;
            out += &format!("<div class=\"card\"><h2>File de relecture ({} items)</h2><p>Langues : {}</p><table><tr><th>Item</th><th>Type</th><th>Langue</th><th>Titre</th></tr>",
                rows.len(), if l.is_empty() { "toutes".into() } else { esc(&l.join(", ")) });
            for r in &rows {
                let id: String = r.get("item_id");
                out += &format!("<tr><td><a href=\"/review/item/{0}\">{0}</a></td><td>{1}</td><td>{2}</td><td>{3}</td></tr>",
                    esc(&id), esc(&r.get::<String, _>("kind")), esc(&r.get::<String, _>("language")), esc(&r.get::<Option<String>, _>("title").unwrap_or_default()));
            }
            out += "</table></div>";
        }
    }
    if u.role == "admin" {
        out += &format!("<div class=\"card\"><h2>Habiliter un relecteur</h2><form method=\"post\" action=\"/review/grant\">{}\
<label>Email du compte (rôle reviewer, teacher ou admin)<input name=\"email\" type=\"email\" required maxlength=\"180\"></label>\
<label>Langues (codes séparés par des virgules, vide = toutes)<input name=\"languages\" maxlength=\"120\"></label><button>Habiliter</button></form></div>", hidden(s, &tok));
        let ag = sqlx::query("SELECT kind, language, items_double_relus, kappa FROM ai_review_agreement ORDER BY 1,2").fetch_all(&s.pool).await?;
        out += "<div class=\"card\"><h2>Accord inter-annotateurs (kappa de Cohen)</h2><table><tr><th>Type</th><th>Langue</th><th>Items double-relus</th><th>Kappa</th></tr>";
        for r in &ag {
            out += &format!("<tr><td>{}</td><td>{}</td><td>{}</td><td>{:.3}</td></tr>", esc(&r.get::<String, _>("kind")), esc(&r.get::<String, _>("language")),
                r.get::<i32, _>("items_double_relus"), r.get::<Option<f64>, _>("kappa").unwrap_or(f64::NAN));
        }
        out += "</table></div>";
    }
    Ok(crate::ui::page(TITLE, &format!("<div class=\"card\"><h1>{TITLE}</h1><p>Relecteur : {} ({}). Double relecture en aveugle : les décisions des autres relecteurs ne sont pas affichées.</p></div>{out}",
        esc(&u.full_name), esc(&u.role))))
}

pub async fn ui_review_item(State(s): State<AppState>, Path(id): Path<String>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async {
        let (u, tok, langs) = session(&s, &hm).await?;
        let l = require_profile(&langs)?;
        let row = sqlx::query("SELECT kind, language, status, source_ref, payload FROM ai_review_items WHERE item_id=$1").bind(&id).fetch_optional(&s.pool).await?
            .ok_or_else(|| AppError::new(404, "ITEM_NOT_FOUND", "Item introuvable."))?;
        let lang: String = row.get("language");
        if !l.is_empty() && !l.contains(&lang) { return Err(AppError::new(403, "LANGUAGE_NOT_GRANTED", "Langue hors de votre habilitation.")); }
        let p: Value = row.get("payload");
        let g = |k: &str| p.get(k).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
        let mine: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_reviews WHERE item_id=$1 AND reviewer_id=$2)").bind(&id).bind(&u.id).fetch_one(&s.pool).await?;
        let mut fields = String::new();
        for k in ["title", "question", "answer", "source_text", "translation", "explanation", "correction", "text", "url", "license", "quality_flags"] {
            if p.get(k).is_some() { fields += &format!("<dt>{}</dt><dd>{}</dd>", esc(k), nl2br(&g(k))); }
        }
        let form = if mine { "<p class=\"ok\">Vous avez déjà relu cet item.</p>".to_string() } else {
            format!("<form method=\"post\" action=\"/review/submit\">{}<input type=\"hidden\" name=\"item_id\" value=\"{}\">\
<label>Décision<select name=\"decision\"><option value=\"accept\">Accepter</option><option value=\"needs_fix\">À corriger</option><option value=\"reject\">Rejeter</option></select></label>\
<label>Note (1-5, facultatif)<input name=\"score\" type=\"number\" min=\"1\" max=\"5\"></label>\
<label>Commentaire<textarea name=\"comment\" maxlength=\"4000\"></textarea></label><button>Enregistrer ma relecture</button></form>", hidden(&s, &tok), esc(&id)) };
        Ok(crate::ui::page(TITLE, &format!("<div class=\"card\"><h1>Item {}</h1><p>Type : {} · Langue : {} · Source : {}</p><dl>{fields}</dl>{form}<p><a href=\"/review\">Retour à la file</a></p></div>",
            esc(&id), esc(&row.get::<String, _>("kind")), esc(&lang), esc(&row.get::<String, _>("source_ref")))))
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(e) }
}

pub async fn ui_review_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                              axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["submit", "grant"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok, langs) = session(&s, &hm).await?;
        check_csrf(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:review:{}", u.id), 60, 60_000).await?;
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let msg = if action == "grant" {
            if u.role != "admin" {
                audit::record(&s.pool, Some((&u.id, &u.role)), "core", "AI_REVIEWER_GRANT", "user", None, "DENIED", Some(&ip), json!({})).await;
                return Err(AppError::new(403, "FORBIDDEN_ROLE", "Seul un administrateur peut habiliter un relecteur."));
            }
            let email = g("email").to_lowercase();
            let target: Option<(String, String)> = sqlx::query_as("SELECT id, role FROM users WHERE lower(email)=$1").bind(&email).fetch_optional(&s.pool).await?;
            let Some((tid, trole)) = target else { return Err(AppError::new(404, "USER_NOT_FOUND", "Compte introuvable.")) };
            if !REVIEW_ROLES.contains(&trole.as_str()) { return Err(AppError::new(400, "ROLE_NOT_ELIGIBLE", "Le compte doit avoir le rôle reviewer, teacher ou admin.")); }
            let l: Vec<String> = g("languages").split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect();
            if l.iter().any(|x| x.len() > 8 || !x.chars().all(|c| c.is_ascii_alphabetic() || c == '-')) { return Err(AppError::new(400, "INVALID_LANGUAGES", "Codes de langue invalides.")); }
            sqlx::query("INSERT INTO ai_reviewer_profiles(user_id, languages, is_active, granted_by) VALUES ($1,$2,TRUE,$3) \
                         ON CONFLICT (user_id) DO UPDATE SET languages=EXCLUDED.languages, is_active=TRUE, granted_by=EXCLUDED.granted_by")
                .bind(&tid).bind(&l).bind(&u.id).execute(&s.pool).await?;
            sqlx::query("INSERT INTO ai_review_audit(actor_id, action, item_id, meta) VALUES ($1,'REVIEWER_GRANTED',NULL,$2)").bind(&u.id).bind(json!({"user_id": tid, "languages": l})).execute(&s.pool).await?;
            audit::record(&s.pool, Some((&u.id, &u.role)), "core", "AI_REVIEWER_GRANT", "user", Some(&tid), "SUCCESS", Some(&ip), json!({"languages": l})).await;
            "Relecteur habilité.".to_string()
        } else {
            let l = require_profile(&langs)?;
            let item = g("item_id"); let decision = g("decision"); let comment = g("comment");
            if !DECISIONS.contains(&decision.as_str()) { return Err(AppError::new(400, "INVALID_DECISION", "Décision invalide.")); }
            if comment.chars().count() > 4000 { return Err(AppError::new(400, "COMMENT_TOO_LONG", "Commentaire trop long.")); }
            let score: Option<i16> = match g("score").as_str() { "" => None, x => match x.parse::<i16>() { Ok(n) if (1..=5).contains(&n) => Some(n), _ => return Err(AppError::new(400, "INVALID_SCORE", "Note entre 1 et 5.")) } };
            let st: Option<(String, String)> = sqlx::query_as("SELECT status, language FROM ai_review_items WHERE item_id=$1").bind(&item).fetch_optional(&s.pool).await?;
            let Some((status, lang)) = st else { return Err(AppError::new(404, "ITEM_NOT_FOUND", "Item introuvable.")) };
            if !l.is_empty() && !l.contains(&lang) { return Err(AppError::new(403, "LANGUAGE_NOT_GRANTED", "Langue hors de votre habilitation.")); }
            if !["pending", "in_review"].contains(&status.as_str()) { return Err(AppError::new(409, "ITEM_CLOSED", "Item déjà clos.")); }
            let res = sqlx::query("INSERT INTO ai_reviews(review_id, item_id, reviewer_id, decision, score, comment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (item_id, reviewer_id) DO NOTHING")
                .bind(crypto::create_id("rev")).bind(&item).bind(&u.id).bind(&decision).bind(score).bind(&comment).execute(&s.pool).await?;
            if res.rows_affected() == 0 {
                audit::record(&s.pool, Some((&u.id, &u.role)), "core", "AI_REVIEW_SUBMIT", "ai_review_item", Some(&item), "DENIED", Some(&ip), json!({"reason": "duplicate"})).await;
                return Err(AppError::new(409, "ALREADY_REVIEWED", "Vous avez déjà relu cet item."));
            }
            audit::record(&s.pool, Some((&u.id, &u.role)), "core", "AI_REVIEW_SUBMIT", "ai_review_item", Some(&item), "SUCCESS", Some(&ip), json!({"decision": decision})).await;
            "Relecture enregistrée.".to_string()
        };
        render_queue(&s, &hm, Some((true, msg))).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roles_and_decisions() {
        for r in REVIEW_ROLES { assert!(rbac::ALL_ROLES.contains(r)); }
        assert!(!REVIEW_ROLES.contains(&"student") && !REVIEW_ROLES.contains(&"operator"));
        assert_eq!(DECISIONS, &["accept", "needs_fix", "reject"]);
        assert_eq!(nl2br("<a>\nb"), "&lt;a&gt;<br>b");
    }
}
