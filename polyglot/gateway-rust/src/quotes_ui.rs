//! Business — tarification « sur devis » : pas de grille de prix publique.
//! Une entreprise connectée dans son espace Entreprise décrit son besoin (besoin, volume, langues, échéance) ;
//! la demande est stockée sous RLS (le client ne voit que les siennes) et affiche son statut.
//! Seule l'équipe SOLOB (reviewer/operator/admin) fait évoluer le statut (trigger quote_status_guard, migration 010).
use crate::{app::AppState, audit, crypto, error::AppError, http as h, rate_limit, ui::esc};
use crate::launch_ui::{check_post, dbe, err_page, flash, hidden, html, page, rls_tx, session, CLIENT_ROLES, STAFF};
use axum::{extract::{Path, State}, http::HeaderMap, response::Response};
use chrono::{NaiveDate, Utc};
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;

const QT: &str = "SOLOB Business — Espace Entreprise · Demande de devis";
pub const QUOTE_STATUSES: &[(&str, &str)] = &[
    ("submitted", "Reçue"), ("in_review", "En étude"), ("quote_sent", "Devis envoyé"),
    ("accepted", "Acceptée"), ("declined", "Déclinée"), ("closed", "Clôturée"),
];
pub fn status_label(s: &str) -> &'static str { QUOTE_STATUSES.iter().find(|(k, _)| *k == s).map(|(_, l)| *l).unwrap_or("Inconnu") }

/// Validation pure des champs de la demande (testée sans base).
pub fn validate_quote(need: &str, volume: &str, languages: &str, deadline: &str, today: NaiveDate) -> Result<NaiveDate, AppError> {
    let n = need.chars().count();
    if !(10..=4000).contains(&n) { return Err(AppError::new(400, "INVALID_NEED", "Décrivez le besoin (10 à 4000 caractères).")); }
    if volume.is_empty() || volume.chars().count() > 300 { return Err(AppError::new(400, "INVALID_VOLUME", "Indiquez le volume (300 caractères maximum).")); }
    if languages.is_empty() || languages.chars().count() > 300 { return Err(AppError::new(400, "INVALID_LANGUAGES", "Indiquez les langues (300 caractères maximum).")); }
    let d = NaiveDate::parse_from_str(deadline, "%Y-%m-%d").map_err(|_| AppError::new(400, "INVALID_DEADLINE", "Échéance invalide (AAAA-MM-JJ)."))?;
    if d < today { return Err(AppError::new(400, "INVALID_DEADLINE", "L'échéance doit être aujourd'hui ou plus tard.")); }
    if d > today + chrono::Duration::days(730) { return Err(AppError::new(400, "INVALID_DEADLINE", "Échéance trop lointaine (2 ans maximum).")); }
    Ok(d)
}

async fn enabled(s: &AppState) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar("SELECT to_regclass('public.business_quote_requests') IS NOT NULL").fetch_one(&s.pool).await?;
    if ok { Ok(()) } else { Err(AppError::new(503, "QUOTES_MODULE_DISABLED", "Module non activé (migration 010 non appliquée).")) }
}

pub async fn ui_quotes(State(s): State<AppState>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async {
        let (u, tok) = session(&s, &hm, CLIENT_ROLES, "business", "QUOTE_REQUEST").await?;
        enabled(&s).await?;
        quotes_page(&s, &u, &tok, None).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(QT, "/business", e) }
}

async fn quotes_page(s: &AppState, u: &crate::rbac::AuthUser, tok: &str, fl: Option<String>) -> Result<String, AppError> {
    let hid = hidden(s, tok);
    let staff = STAFF.contains(&u.role.as_str());
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    out += "<div class=\"card\"><h1>Tarification : sur devis</h1><p>SOLOB Business ne publie pas de grille de prix : chaque besoin (staffing, annotation, traduction, création) est chiffré sur devis après étude. Aucun paiement n'est demandé sur cette page.</p></div>";
    if !staff {
        out += &format!("<div class=\"card\"><h2>Demander un devis</h2><form method=\"post\" action=\"/enterprise/quotes/request\">{hid}\
<label>Besoin (10 à 4000 caractères)<textarea name=\"need\" required minlength=\"10\" maxlength=\"4000\"></textarea></label>\
<label>Volume (ex. 40 h d'audio, 2 ingénieurs, 5 000 mots)<input name=\"volume\" required maxlength=\"300\"></label>\
<label>Langues (ex. fon, yoruba, français)<input name=\"languages\" required maxlength=\"300\"></label>\
<label>Échéance souhaitée<input type=\"date\" name=\"deadline\" required></label><button type=\"submit\">Envoyer la demande de devis</button></form></div>");
    }
    let mut tx = rls_tx(s, u).await?;
    let rows = sqlx::query("SELECT quote_id, need, volume, languages, deadline, status, staff_note, created_at FROM business_quote_requests ORDER BY created_at DESC LIMIT 100")
        .fetch_all(&mut *tx).await.map_err(dbe)?;
    tx.commit().await?;
    out += &format!("<div class=\"card\"><h2>{}</h2>", if staff { "Demandes de devis des entreprises" } else { "Mes demandes de devis" });
    if rows.is_empty() { out += "<p>Aucune demande de devis.</p>"; }
    for r in rows {
        let id: String = r.get("quote_id");
        let st: String = r.get("status");
        let d: NaiveDate = r.get("deadline");
        out += &format!("<div class=\"card\"><p><strong>Statut :</strong> <span class=\"pill\">{}</span> — échéance {} — reçue le {}</p><p>{}</p><p>Volume : {} · Langues : {}</p>",
            status_label(&st), d.format("%d/%m/%Y"), crate::launch_ui::local(r.get("created_at")), esc(r.get("need")), esc(r.get("volume")), esc(r.get("languages")));
        let note: String = r.get("staff_note");
        if !note.is_empty() { out += &format!("<p>Note de l'équipe : {}</p>", esc(&note)); }
        if staff {
            let opts: String = QUOTE_STATUSES.iter().map(|(k, l)| format!("<option value=\"{k}\"{}>{l}</option>", if *k == st { " selected" } else { "" })).collect();
            out += &format!("<form method=\"post\" action=\"/enterprise/quotes/status\">{hid}<input type=\"hidden\" name=\"quote_id\" value=\"{}\">\
<label>Statut<select name=\"status\">{opts}</select></label><label>Note pour le client<input name=\"staff_note\" maxlength=\"2000\" value=\"{}\"></label><button type=\"submit\">Mettre à jour</button></form>", esc(&id), esc(&note));
        }
        out += "</div>";
    }
    out += "</div><p><a href=\"/client\">Espace client</a> · <a href=\"/business\">Retour à Business</a></p>";
    Ok(page(QT, &out))
}

pub async fn ui_quotes_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["request", "status"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm, CLIENT_ROLES, "business", "QUOTE_REQUEST").await?;
        enabled(&s).await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:quotes:{}", u.id), 20, 60_000).await?;
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let staff = STAFF.contains(&u.role.as_str());
        let mut tx = rls_tx(&s, &u).await?;
        let msg = if action == "request" {
            if staff { return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé aux entreprises clientes.")); }
            let d = validate_quote(&g("need"), &g("volume"), &g("languages"), &g("deadline"), (Utc::now() + chrono::Duration::hours(1)).date_naive())?;
            let id = crypto::create_id("quote");
            sqlx::query("INSERT INTO business_quote_requests(quote_id, client_id, need, volume, languages, deadline) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(&id).bind(&u.id).bind(g("need")).bind(g("volume")).bind(g("languages")).bind(d).execute(&mut *tx).await.map_err(dbe)?;
            audit::record(&s.pool, actor, "business", "QUOTE_REQUEST_CREATED", "quote_request", Some(&id), "SUCCESS", Some(&ip), json!({"deadline": d.to_string()})).await;
            "Demande de devis enregistrée (statut : Reçue). L'équipe SOLOB vous répondra avec un devis.".to_string()
        } else {
            if !staff {
                audit::record(&s.pool, actor, "business", "QUOTE_STATUS_UPDATE", "quote_request", None, "DENIED", Some(&ip), json!({"reason": "role"})).await;
                return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé à l'équipe SOLOB."));
            }
            let st = g("status");
            if !QUOTE_STATUSES.iter().any(|(k, _)| *k == st) { return Err(AppError::new(400, "INVALID_STATUS", "Statut inconnu.")); }
            let id = g("quote_id");
            let n = sqlx::query("UPDATE business_quote_requests SET status=$2, staff_note=$3, handled_by=$4 WHERE quote_id=$1")
                .bind(&id).bind(&st).bind(g("staff_note").chars().take(2000).collect::<String>()).bind(&u.id).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
            if n == 0 { return Err(AppError::new(404, "QUOTE_NOT_FOUND", "Demande introuvable.")); }
            audit::record(&s.pool, actor, "business", "QUOTE_STATUS_UPDATE", "quote_request", Some(&id), "SUCCESS", Some(&ip), json!({"status": st})).await;
            format!("Statut mis à jour : {}.", status_label(&st))
        };
        tx.commit().await?;
        quotes_page(&s, &u, &tok, Some(msg)).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(QT, "/enterprise/quotes", e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(s: &str) -> NaiveDate { NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap() }
    #[test] fn valid_quote() { assert_eq!(validate_quote("Annotation audio fon", "40 h", "fon", "2026-12-01", d("2026-11-03")).unwrap(), d("2026-12-01")); }
    #[test] fn rejects_bad_fields() {
        let t = d("2026-11-03");
        assert_eq!(validate_quote("court", "1", "fon", "2026-12-01", t).unwrap_err().code, "INVALID_NEED");
        assert_eq!(validate_quote("Besoin suffisant", "", "fon", "2026-12-01", t).unwrap_err().code, "INVALID_VOLUME");
        assert_eq!(validate_quote("Besoin suffisant", "1", "", "2026-12-01", t).unwrap_err().code, "INVALID_LANGUAGES");
        assert_eq!(validate_quote("Besoin suffisant", "1", "fon", "2026-11-02", t).unwrap_err().code, "INVALID_DEADLINE");
        assert_eq!(validate_quote("Besoin suffisant", "1", "fon", "01/12/2026", t).unwrap_err().code, "INVALID_DEADLINE");
    }
    #[test] fn labels() { assert_eq!(status_label("quote_sent"), "Devis envoyé"); assert_eq!(status_label("x"), "Inconnu"); }
}
