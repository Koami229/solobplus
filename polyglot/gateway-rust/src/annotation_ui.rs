//! US-T05 — écran SSR de l'annotatrice (transcription + traduction d'un segment audio), sans JavaScript.
//! Règles (appliquées en base par la migration 010, et vérifiées ici avant écriture) :
//! - une source audio n'est enregistrée qu'avec sa preuve de droits, sa référence de consentement du locuteur et la date du consentement ;
//! - une tâche soumise passe « à relire » seulement avec transcription ET traduction ;
//! - le relecteur doit être différent de l'auteur (SELF_REVIEW) ; un refus exige un commentaire ;
//! - la livraison n'est possible qu'après validation (STEP_ORDER).
//! Les preuves de droits et de consentement ne sont visibles que de l'équipe (RLS, migration 011) ;
//! les annotatrices voient titre, langue et licence via la vue annotation_sources_catalog.
use crate::{app::AppState, audit, crypto, error::AppError, http as h, rate_limit, ui::esc};
use crate::launch_ui::{check_post, dbe, err_page, flash, hidden, html, page, rls_tx, session, STAFF, TALENT_ROLES};
use axum::{extract::{Path, State}, http::HeaderMap, response::Response};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::json;
use sqlx::Row;
use std::collections::HashMap;

const AT: &str = "SOLOB Business — Annotation audio";
pub const TASK_STATUSES: &[(&str, &str)] = &[
    ("open", "Ouverte"), ("to_review", "À relire"), ("validated", "Validée"), ("rejected", "Refusée — à corriger"), ("delivered", "Livrée"),
];
pub fn status_label(s: &str) -> &'static str { TASK_STATUSES.iter().find(|(k, _)| *k == s).map(|(_, l)| *l).unwrap_or("Inconnu") }

pub fn validate_source(title: &str, language: &str, license: &str, rights: &str, consent: &str, consent_date: &str, today: NaiveDate) -> Result<NaiveDate, AppError> {
    let len = |v: &str| v.chars().count();
    if !(3..=200).contains(&len(title)) { return Err(AppError::new(400, "INVALID_TITLE", "Titre : 3 à 200 caractères.")); }
    if !(2..=40).contains(&len(language)) { return Err(AppError::new(400, "INVALID_LANGUAGE", "Langue requise.")); }
    if !(2..=80).contains(&len(license)) { return Err(AppError::new(400, "INVALID_LICENSE", "Licence requise.")); }
    if !(3..=500).contains(&len(rights)) { return Err(AppError::new(400, "RIGHTS_REQUIRED", "Preuve de droits requise (contrat, licence, autorisation).")); }
    if !(3..=200).contains(&len(consent)) { return Err(AppError::new(400, "CONSENT_REQUIRED", "Référence du consentement du locuteur requise.")); }
    let d = NaiveDate::parse_from_str(consent_date, "%Y-%m-%d").map_err(|_| AppError::new(400, "CONSENT_REQUIRED", "Date du consentement requise (AAAA-MM-JJ)."))?;
    if d > today { return Err(AppError::new(400, "CONSENT_REQUIRED", "La date du consentement ne peut pas être future.")); }
    Ok(d)
}
pub fn validate_segment(start: &str, end: &str) -> Result<(i32, i32), AppError> {
    let bad = || AppError::new(400, "INVALID_SEGMENT", "Segment invalide : début ≥ 0, fin > début, 120 s maximum (en millisecondes).");
    let s: i32 = start.parse().map_err(|_| bad())?; let e: i32 = end.parse().map_err(|_| bad())?;
    if s < 0 || e <= s || e - s > 120_000 { return Err(bad()); }
    Ok((s, e))
}
pub fn validate_annotation(transcription: &str, translation: &str) -> Result<(), AppError> {
    let n = |v: &str| v.trim().chars().count();
    if !(1..=5000).contains(&n(transcription)) || !(1..=5000).contains(&n(translation)) {
        return Err(AppError::new(400, "STEP_ORDER", "Transcription et traduction en français requises (5000 caractères maximum chacune)."));
    }
    Ok(())
}
fn ms(v: i32) -> String { format!("{}:{:02}.{:01}", v / 60_000, (v / 1000) % 60, (v % 1000) / 100) }

async fn enabled(s: &AppState) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar("SELECT to_regclass('public.annotation_tasks') IS NOT NULL AND to_regclass('public.annotation_sources_catalog') IS NOT NULL").fetch_one(&s.pool).await?;
    if ok { Ok(()) } else { Err(AppError::new(503, "ANNOTATION_MODULE_DISABLED", "Module non activé (migrations 010 et 011 non appliquées).")) }
}

pub async fn ui_annotation(State(s): State<AppState>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async {
        let (u, tok) = session(&s, &hm, TALENT_ROLES, "business", "ANNOTATION").await?;
        enabled(&s).await?;
        annotation_page(&s, &u, &tok, None).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(AT, "/talent", e) }
}

async fn annotation_page(s: &AppState, u: &crate::rbac::AuthUser, tok: &str, fl: Option<String>) -> Result<String, AppError> {
    let hid = hidden(s, tok);
    let staff = STAFF.contains(&u.role.as_str());
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    out += "<div class=\"card\"><h1>Annotation audio</h1><p>Transcrivez le segment dans sa langue, puis traduisez-le en français. Une tâche soumise passe « à relire » ; elle n'est livrée qu'après validation par un second relecteur, différent de l'auteur. Chaque source a une preuve de droits et un consentement du locuteur enregistrés.</p></div>";
    let mut tx = rls_tx(s, u).await?;
    let rows = sqlx::query("SELECT t.task_id, t.source_id, t.segment_start_ms, t.segment_end_ms, t.author_id, t.transcription, t.translation_fr, t.status, t.reviewer_id, t.review_comment, t.submitted_at, \
c.title, c.language, c.license FROM annotation_tasks t JOIN annotation_sources_catalog c USING (source_id) ORDER BY t.created_at DESC LIMIT 200")
        .fetch_all(&mut *tx).await.map_err(dbe)?;
    let sources = if staff {
        sqlx::query("SELECT source_id, title, language, license, rights_proof, speaker_consent_ref, consent_recorded_at FROM annotation_audio_sources ORDER BY created_at DESC LIMIT 100").fetch_all(&mut *tx).await.map_err(dbe)?
    } else { vec![] };
    tx.commit().await?;
    let (mut open, mut mine, mut review, mut other) = (String::new(), String::new(), String::new(), String::new());
    for r in rows {
        let id: String = r.get("task_id"); let st: String = r.get("status");
        let author: Option<String> = r.get("author_id");
        let head = format!("<p><strong>{}</strong> ({}, licence {}) — segment {} → {} · <span class=\"pill\">{}</span></p>",
            esc(r.get("title")), esc(r.get("language")), esc(r.get("license")), ms(r.get("segment_start_ms")), ms(r.get("segment_end_ms")), status_label(&st));
        let tr: String = r.get::<Option<String>, _>("transcription").unwrap_or_default();
        let tf: String = r.get::<Option<String>, _>("translation_fr").unwrap_or_default();
        let comment: String = r.get("review_comment");
        let idh = format!("<input type=\"hidden\" name=\"task_id\" value=\"{}\">", esc(&id));
        let is_mine = author.as_deref() == Some(u.id.as_str());
        if st == "open" && author.is_none() {
            open += &format!("<div class=\"card\">{head}<form method=\"post\" action=\"/annotation/claim\">{hid}{idh}<button type=\"submit\">Prendre cette tâche</button></form></div>");
        } else if is_mine && (st == "open" || st == "rejected") {
            let c = if comment.is_empty() { String::new() } else { format!("<p class=\"err\">Commentaire du relecteur : {}</p>", esc(&comment)) };
            mine += &format!("<div class=\"card\">{head}{c}<form method=\"post\" action=\"/annotation/submit\">{hid}{idh}\
<label>Transcription (langue d'origine)<textarea name=\"transcription\" required maxlength=\"5000\">{}</textarea></label>\
<label>Traduction en français<textarea name=\"translation_fr\" required maxlength=\"5000\">{}</textarea></label>\
<button type=\"submit\">Soumettre pour relecture</button></form></div>", esc(&tr), esc(&tf));
        } else if staff && st == "to_review" && !is_mine {
            review += &format!("<div class=\"card\">{head}<p>Transcription : {}</p><p>Traduction : {}</p><form method=\"post\" action=\"/annotation/review\">{hid}{idh}\
<label>Commentaire (obligatoire en cas de refus)<input name=\"comment\" maxlength=\"2000\"></label>\
<button type=\"submit\" name=\"decision\" value=\"validated\">Valider</button> <button type=\"submit\" name=\"decision\" value=\"rejected\">Refuser</button></form></div>", esc(&tr), esc(&tf));
        } else {
            let mut x = format!("<div class=\"card\">{head}");
            if is_mine || staff { x += &format!("<p>Transcription : {}</p><p>Traduction : {}</p>", esc(&tr), esc(&tf)); }
            if st == "to_review" && is_mine { x += "<p>En attente d'un second relecteur (vous ne pouvez pas relire votre propre tâche).</p>"; }
            if staff && st == "validated" { x += &format!("<form method=\"post\" action=\"/annotation/deliver\">{hid}{idh}<button type=\"submit\">Livrer au jeu de données</button></form>"); }
            x += "</div>"; other += &x;
        }
    }
    let sec = |t: &str, b: &str, empty: &str| format!("<div class=\"card\"><h2>{t}</h2>{}</div>", if b.is_empty() { format!("<p>{empty}</p>") } else { b.to_string() });
    out += &sec("Mes tâches en cours", &mine, "Aucune tâche en cours.");
    out += &sec("Tâches disponibles", &open, "Aucune tâche disponible.");
    if staff { out += &sec("À relire (second relecteur)", &review, "Rien à relire."); }
    out += &sec(if staff { "Autres tâches" } else { "Mes tâches soumises ou livrées" }, &other, "Aucune.");
    if staff {
        let today = Utc::now().date_naive().format("%Y-%m-%d");
        let opts: String = sources.iter().map(|r| format!("<option value=\"{}\">{} ({})</option>", esc(r.get("source_id")), esc(r.get("title")), esc(r.get("language")))).collect();
        out += &format!("<div class=\"card\"><h2>Enregistrer une source audio</h2><form method=\"post\" action=\"/annotation/source\">{hid}\
<label>Titre<input name=\"title\" required maxlength=\"200\"></label><label>Langue<input name=\"language\" required maxlength=\"40\" placeholder=\"fon\"></label>\
<label>Licence<input name=\"license\" required maxlength=\"80\" placeholder=\"CC-BY-4.0\"></label>\
<label>Preuve de droits (référence du contrat ou de l'autorisation)<input name=\"rights_proof\" required maxlength=\"500\"></label>\
<label>Référence du consentement du locuteur<input name=\"speaker_consent_ref\" required maxlength=\"200\"></label>\
<label>Date du consentement<input type=\"date\" name=\"consent_date\" required max=\"{today}\"></label><button type=\"submit\">Enregistrer la source</button></form></div>");
        if !sources.is_empty() {
            out += &format!("<div class=\"card\"><h2>Créer une tâche</h2><form method=\"post\" action=\"/annotation/task\">{hid}<label>Source<select name=\"source_id\">{opts}</select></label>\
<label>Début (ms)<input name=\"start_ms\" inputmode=\"numeric\" required></label><label>Fin (ms)<input name=\"end_ms\" inputmode=\"numeric\" required></label><button type=\"submit\">Créer la tâche</button></form></div>");
            out += "<div class=\"card\"><h2>Sources (équipe uniquement)</h2><table><tr><th>Source</th><th>Licence</th><th>Preuve de droits</th><th>Consentement</th></tr>";
            for r in &sources {
                let d: DateTime<Utc> = r.get("consent_recorded_at");
                out += &format!("<tr><td>{} ({})</td><td>{}</td><td>{}</td><td>{} — {}</td></tr>", esc(r.get("title")), esc(r.get("language")), esc(r.get("license")), esc(r.get("rights_proof")), esc(r.get("speaker_consent_ref")), d.format("%d/%m/%Y"));
            }
            out += "</table></div>";
        }
    }
    out += "<p><a href=\"/talent\">Mon parcours talent</a> · <a href=\"/business\">Retour à Business</a></p>";
    Ok(page(AT, &out))
}

pub async fn ui_annotation_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["source", "task", "claim", "submit", "review", "deliver"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm, TALENT_ROLES, "business", "ANNOTATION").await?;
        enabled(&s).await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:annotation:{}", u.id), 60, 60_000).await?;
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let staff = STAFF.contains(&u.role.as_str());
        if ["source", "task", "review", "deliver"].contains(&action.as_str()) && !staff {
            audit::record(&s.pool, actor, "business", "ANNOTATION_STAFF_ACTION", "annotation_task", None, "DENIED", Some(&ip), json!({"action": action})).await;
            return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé à l'équipe SOLOB (relecteurs)."));
        }
        let tid = g("task_id");
        let mut tx = rls_tx(&s, &u).await?;
        let not_found = || AppError::new(409, "STEP_ORDER", "Étape refusée : tâche introuvable ou pas dans le bon état.");
        let (msg, target, ev) = match action.as_str() {
            "source" => {
                let d = validate_source(&g("title"), &g("language"), &g("license"), &g("rights_proof"), &g("speaker_consent_ref"), &g("consent_date"), (Utc::now() + chrono::Duration::hours(1)).date_naive())?;
                let id = crypto::create_id("asrc");
                sqlx::query("INSERT INTO annotation_audio_sources(source_id,title,language,license,rights_proof,speaker_consent_ref,consent_recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7::date)")
                    .bind(&id).bind(g("title")).bind(g("language")).bind(g("license")).bind(g("rights_proof")).bind(g("speaker_consent_ref")).bind(d).execute(&mut *tx).await.map_err(dbe)?;
                ("Source enregistrée avec sa preuve de droits et son consentement.".to_string(), id, "ANNOTATION_SOURCE_CREATED")
            }
            "task" => {
                let (a, b) = validate_segment(&g("start_ms"), &g("end_ms"))?;
                let id = crypto::create_id("atask");
                sqlx::query("INSERT INTO annotation_tasks(task_id,source_id,segment_start_ms,segment_end_ms) VALUES ($1,$2,$3,$4)")
                    .bind(&id).bind(g("source_id")).bind(a).bind(b).execute(&mut *tx).await.map_err(|e| { let m = e.to_string(); if m.contains("foreign key") { AppError::new(400, "UNKNOWN_SOURCE", "Source inconnue.") } else { dbe(e) } })?;
                ("Tâche créée (statut : Ouverte).".to_string(), id, "ANNOTATION_TASK_CREATED")
            }
            "claim" => {
                let n = sqlx::query("UPDATE annotation_tasks SET author_id=$2 WHERE task_id=$1 AND status='open' AND author_id IS NULL").bind(&tid).bind(&u.id).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
                if n == 0 { return Err(not_found()); }
                ("Tâche prise : transcrivez puis traduisez le segment.".to_string(), tid.clone(), "ANNOTATION_TASK_CLAIMED")
            }
            "submit" => {
                validate_annotation(&g("transcription"), &g("translation_fr"))?;
                let n = sqlx::query("UPDATE annotation_tasks SET transcription=$3, translation_fr=$4, status='to_review', submitted_at=now(), reviewer_id=NULL, reviewed_at=NULL \
WHERE task_id=$1 AND author_id=$2 AND status IN ('open','rejected')").bind(&tid).bind(&u.id).bind(g("transcription")).bind(g("translation_fr")).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
                if n == 0 { return Err(not_found()); }
                ("Tâche soumise : statut « À relire ». Un second relecteur doit la valider.".to_string(), tid.clone(), "ANNOTATION_TASK_SUBMITTED")
            }
            "review" => {
                let dec = g("decision"); let c = g("comment");
                if !["validated", "rejected"].contains(&dec.as_str()) { return Err(AppError::new(400, "INVALID_DECISION", "Décision inconnue.")); }
                if dec == "rejected" && c.is_empty() { return Err(AppError::new(400, "COMMENT_REQUIRED", "Un refus exige un commentaire.")); }
                let n = sqlx::query("UPDATE annotation_tasks SET status=$3, reviewer_id=$2, reviewed_at=now(), review_comment=$4 WHERE task_id=$1 AND status='to_review'")
                    .bind(&tid).bind(&u.id).bind(&dec).bind(c.chars().take(2000).collect::<String>()).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
                if n == 0 { return Err(not_found()); }
                (if dec == "validated" { "Tâche validée : elle peut être livrée." } else { "Tâche refusée avec commentaire : renvoyée à l'auteur." }.to_string(), tid.clone(), "ANNOTATION_TASK_REVIEWED")
            }
            _ => {
                let n = sqlx::query("UPDATE annotation_tasks SET status='delivered', delivered_at=now() WHERE task_id=$1").bind(&tid).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
                if n == 0 { return Err(not_found()); }
                ("Tâche livrée au jeu de données.".to_string(), tid.clone(), "ANNOTATION_TASK_DELIVERED")
            }
        };
        tx.commit().await?;
        audit::record(&s.pool, actor, "business", ev, "annotation_task", Some(&target), "SUCCESS", Some(&ip), json!({"action": action, "decision": g("decision")})).await;
        annotation_page(&s, &u, &tok, Some(msg)).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(AT, "/annotation", e) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d(s: &str) -> NaiveDate { NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap() }
    #[test] fn source_requires_rights_and_consent() {
        let t = d("2026-11-03");
        assert!(validate_source("Conte fon", "fon", "CC-BY-4.0", "contrat-01", "consent-7", "2026-10-01", t).is_ok());
        assert_eq!(validate_source("Conte fon", "fon", "CC-BY-4.0", "", "consent-7", "2026-10-01", t).unwrap_err().code, "RIGHTS_REQUIRED");
        assert_eq!(validate_source("Conte fon", "fon", "CC-BY-4.0", "contrat-01", "", "2026-10-01", t).unwrap_err().code, "CONSENT_REQUIRED");
        assert_eq!(validate_source("Conte fon", "fon", "CC-BY-4.0", "contrat-01", "consent-7", "", t).unwrap_err().code, "CONSENT_REQUIRED");
        assert_eq!(validate_source("Conte fon", "fon", "CC-BY-4.0", "contrat-01", "consent-7", "2026-12-01", t).unwrap_err().code, "CONSENT_REQUIRED");
    }
    #[test] fn segments_and_annotation() {
        assert_eq!(validate_segment("0", "15000").unwrap(), (0, 15000));
        for (a, b) in [("-1", "10"), ("10", "10"), ("0", "200000"), ("x", "1")] { assert!(validate_segment(a, b).is_err()); }
        assert!(validate_annotation("Mi kú dé", "Bonjour").is_ok());
        assert!(validate_annotation("Mi kú dé", " ").is_err());
        assert_eq!(ms(75_300), "1:15.3");
        assert_eq!(status_label("to_review"), "À relire");
    }
}
