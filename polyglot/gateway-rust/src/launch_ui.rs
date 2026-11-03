//! Stories Must du lancement, rendues côté serveur sans JavaScript (CSP stricte inchangée) :
//! S04 examens blancs (School, gratuit) · T01 parcours talent · C01 demande client + appel · C02 shortlist · P02 demande de suppression.
//! Même pipeline que /contribute : session → RBAC → CSRF HMAC → limitation de débit → écriture auditée.
//! Les tables de 009 sont protégées par RLS : chaque accès passe par `rls_tx` (SET LOCAL ROLE solob_app + app.user_id).
//! Nécessite db/migrations-ai/009_launch_must.sql ; sans elle les pages répondent 503 « module non activé ».
use crate::{app::AppState, audit, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{extract::{Path, State}, http::{header, HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}};
use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Timelike, Utc};
use serde_json::{json, Value};
use sqlx::{Postgres, Row, Transaction};
use std::collections::HashMap;

/// Fuseau des utilisateurs (Bénin) : UTC+1 sans heure d'été.
pub const LOCAL_OFFSET_H: i64 = 1;
/// Tolérance réseau après l'échéance d'un examen avant de marquer la copie « hors délai ».
pub const EXAM_GRACE_S: i64 = 30;
/// Délai défini de traitement d'une demande de suppression de compte (P02).
pub const DELETION_DUE_DAYS: i64 = 30;
pub const TALENT_PASS: i32 = 2;
pub(crate) const STAFF: &[&str] = &["reviewer", "operator", "admin"];
/// Test de compétences du parcours talent (corrigé côté serveur, réponses jamais envoyées).
pub const TALENT_TEST: &[(&str, &[&str], usize)] = &[
    ("Une annotation de qualité doit être :", &["rapide avant tout", "cohérente avec le guide d'annotation", "la plus longue possible"], 1),
    ("Face à un audio inaudible, vous :", &["inventez le texte", "marquez le segment [inaudible]", "supprimez le fichier"], 1),
    ("Une donnée personnelle dans un texte à traduire doit être :", &["signalée et masquée selon la consigne", "publiée", "ignorée"], 0),
];

pub(crate) fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}
pub(crate) fn page(title: &str, body: &str) -> String { crate::ui::page(title, body) }
pub(crate) fn err_page(title: &str, back: &str, e: AppError) -> Response {
    html(e.status, page(title, &format!("<div class=\"card\"><h1>{}</h1><p class=\"err\">{}</p><p><a href=\"{back}\">Retour</a></p></div>", esc(title), esc(&e.message))))
}
pub(crate) fn flash(m: &str) -> String { format!("<div class=\"card ok\" role=\"status\">{}</div>", esc(m)) }
/// Convertit les refus des triggers/contraintes de 009 en erreurs métier lisibles (sinon 500 générique).
pub(crate) fn dbe(e: sqlx::Error) -> AppError {
    let m = e.to_string();
    if m.contains("SELF_REVIEW") { return AppError::new(403, "SELF_REVIEW_FORBIDDEN", "Auto-revue interdite : un autre relecteur doit valider."); }
    if m.contains("STEP_ORDER") { return AppError::new(409, "STEP_ORDER", "Étape refusée : l'étape précédente n'est pas validée."); }
    if m.contains("NOT_BADGED") { return AppError::new(409, "NOT_BADGED", "Seul un talent badgé peut figurer dans une shortlist."); }
    if m.contains("client_requests_slot_uq") { return AppError::new(409, "SLOT_TAKEN", "Ce créneau est déjà réservé, choisissez-en un autre."); }
    if m.contains("QUOTE_STATUS") { return AppError::new(403, "QUOTE_STATUS", "Le statut d'un devis est géré par l'équipe SOLOB."); }
    if m.contains("row-level security") { return AppError::new(403, "RLS_DENIED", "Accès refusé à cet espace."); }
    AppError::from(e)
}
/// Fuseau d'affichage du client (décalage entier en heures, −12…+14).
pub fn parse_tz(v: &str) -> Result<i64, AppError> {
    let h: i64 = if v.is_empty() { LOCAL_OFFSET_H } else { v.parse().map_err(|_| AppError::new(400, "INVALID_TZ", "Fuseau invalide."))? };
    if !(-12..=14).contains(&h) { return Err(AppError::new(400, "INVALID_TZ", "Fuseau invalide.")); }
    Ok(h)
}
pub fn in_tz(t: DateTime<Utc>, h: i64) -> String { format!("{} (UTC{}{})", (t + Duration::hours(h)).format("%d/%m/%Y %H:%M"), if h < 0 { "−" } else { "+" }, h.abs()) }
pub fn local(t: DateTime<Utc>) -> String { (t + Duration::hours(LOCAL_OFFSET_H)).format("%d/%m/%Y %H:%M").to_string() + " (heure du Bénin, UTC+1)" }

async fn enabled(s: &AppState) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar("SELECT to_regclass('public.school_mock_exams') IS NOT NULL AND to_regclass('public.client_shortlists') IS NOT NULL").fetch_one(&s.pool).await?;
    if ok { Ok(()) } else { Err(AppError::new(503, "LAUNCH_MODULE_DISABLED", "Module non activé (migration 009 non appliquée).")) }
}
pub(crate) async fn session(s: &AppState, hm: &HeaderMap, roles: &[&str], pillar: &str, op: &str) -> Result<(rbac::AuthUser, String), AppError> {
    enabled(s).await?;
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), roles, pillar, op)?;
    Ok((u.unwrap(), tok.unwrap()))
}
pub(crate) fn hidden(s: &AppState, tok: &str) -> String {
    format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)))
}
pub(crate) fn check_post(s: &AppState, hm: &HeaderMap, tok: &str, f: &HashMap<String, String>) -> Result<(), AppError> {
    let csrf = f.get("csrf").map(String::as_str).unwrap_or("");
    h::enforce_csrf(&Method::POST, hm, Some(csrf))?;
    if !crypto::verify_csrf_token(&s.cfg.session_secret, tok, csrf) { return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); }
    Ok(())
}
/// Transaction soumise à la RLS : rôle applicatif sans privilège + identité de l'utilisateur courant.
pub async fn rls_tx<'a>(s: &'a AppState, u: &rbac::AuthUser) -> Result<Transaction<'a, Postgres>, AppError> {
    let mut tx = s.pool.begin().await?;
    let staff = if STAFF.contains(&u.role.as_str()) { "on" } else { "off" };
    sqlx::query("SELECT set_config('app.user_id', $1, true), set_config('app.staff', $2, true)").bind(&u.id).bind(staff).execute(&mut *tx).await?;
    sqlx::query("SET LOCAL ROLE solob_app").execute(&mut *tx).await?;
    Ok(tx)
}

// ===================== S04 : examens blancs =====================
const EX_T: &str = "SOLOB School — Examens blancs";

pub async fn ui_exams(State(s): State<AppState>, hm: HeaderMap) -> Response {
    match exams_page(&s, &hm, None).await { Ok(b) => html(200, b), Err(e) => err_page(EX_T, "/school", e) }
}
async fn exams_page(s: &AppState, hm: &HeaderMap, fl: Option<String>) -> Result<String, AppError> {
    let (u, tok) = session(s, hm, rbac::SCHOOL_ROLES, "school", "MOCK_EXAM").await?;
    let hid = hidden(s, &tok);
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    out += "<div class=\"card\"><h1>Examens blancs</h1><p>Entièrement gratuit. Chaque épreuve est chronométrée et corrigée côté serveur ; votre progression est conservée.</p></div>";
    let rows = sqlx::query("SELECT exam_id, exam_code, country, level, subject, title, duration_minutes, verified, jsonb_array_length(questions) n FROM school_mock_exams ORDER BY exam_code, title").fetch_all(&s.pool).await?;
    for r in rows {
        let ver = if r.get::<bool, _>("verified") { "<span class=\"badge\">Contenu vérifié</span>" } else { "<span class=\"badge warn\">Contenu non vérifié — pilote</span>" };
        out += &format!("<div class=\"card\"><h2>{}</h2><p>{} · {} · {} · {} — {} questions, {} min {ver}</p>\
<form method=\"post\" action=\"/school/exams/start\">{hid}<input type=\"hidden\" name=\"exam_id\" value=\"{}\"><button type=\"submit\">Commencer l'épreuve</button></form></div>",
            esc(r.get("title")), esc(r.get("exam_code")), esc(r.get("country")), esc(r.get("level")), esc(r.get("subject")),
            r.get::<i32, _>("n"), r.get::<i32, _>("duration_minutes"), esc(r.get("exam_id")));
    }
    let mut tx = rls_tx(s, &u).await?;
    let att = sqlx::query("SELECT a.attempt_id, e.title, a.started_at, a.submitted_at, a.score, a.max_score, a.late FROM school_exam_attempts a JOIN school_mock_exams e USING (exam_id) ORDER BY a.started_at DESC LIMIT 20")
        .fetch_all(&mut *tx).await.map_err(dbe)?;
    tx.commit().await?;
    out += "<div class=\"card\"><h2>Ma progression</h2>";
    if att.is_empty() { out += "<p>Aucune tentative pour l'instant.</p>"; }
    else {
        out += "<table><tr><th>Épreuve</th><th>Début</th><th>Résultat</th></tr>";
        for a in att {
            let res = match a.get::<Option<i32>, _>("score") {
                Some(sc) => format!("{sc}/{}{}", a.get::<Option<i32>, _>("max_score").unwrap_or(0), if a.get::<bool, _>("late") { " — hors délai" } else { "" }),
                None => "en cours".into() };
            out += &format!("<tr><td><a href=\"/school/exams/attempt/{}\">{}</a></td><td>{}</td><td>{}</td></tr>", esc(a.get("attempt_id")), esc(a.get("title")), local(a.get("started_at")), esc(&res));
        }
        out += "</table>";
    }
    out += "</div><p><a href=\"/school\">Retour à School</a></p>";
    Ok(page(EX_T, &out))
}

pub async fn ui_exam_attempt(State(s): State<AppState>, Path(id): Path<String>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async {
        let (u, tok) = session(&s, &hm, rbac::SCHOOL_ROLES, "school", "MOCK_EXAM").await?;
        attempt_page(&s, &u, &tok, &id, None).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(EX_T, "/school/exams", e) }
}
async fn attempt_page(s: &AppState, u: &rbac::AuthUser, tok: &str, id: &str, fl: Option<String>) -> Result<String, AppError> {
    let mut tx = rls_tx(s, u).await?;
    let a = sqlx::query("SELECT a.attempt_id, a.deadline_at, a.submitted_at, a.answers, a.score, a.max_score, a.late, e.title, e.questions, e.verified FROM school_exam_attempts a JOIN school_mock_exams e USING (exam_id) WHERE a.attempt_id=$1")
        .bind(id).fetch_optional(&mut *tx).await.map_err(dbe)?;
    tx.commit().await?;
    // RLS : la tentative d'un autre élève est invisible → 404 (pas de fuite d'existence).
    let a = a.ok_or_else(|| AppError::new(404, "ATTEMPT_NOT_FOUND", "Tentative introuvable."))?;
    let qs: Value = a.get("questions");
    let qs = qs.as_array().cloned().unwrap_or_default();
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    out += &format!("<div class=\"card\"><h1>{}</h1>", esc(a.get("title")));
    if !a.get::<bool, _>("verified") { out += "<p class=\"warn\">Contenu non vérifié — épreuve pilote, ne remplace pas les annales officielles.</p>"; }
    match a.get::<Option<DateTime<Utc>>, _>("submitted_at") {
        None => {
            out += &format!("<p>À rendre avant : <strong>{}</strong>. Une copie rendue après l'échéance est corrigée mais marquée « hors délai ».</p>\
<form method=\"post\" action=\"/school/exams/submit\">{}<input type=\"hidden\" name=\"attempt_id\" value=\"{}\">", local(a.get("deadline_at")), hidden(s, tok), esc(a.get("attempt_id")));
            for (i, q) in qs.iter().enumerate() {
                out += &format!("<fieldset><legend>{}. {}</legend>", i + 1, esc(q["q"].as_str().unwrap_or("")));
                for (j, c) in q["choices"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                    out += &format!("<label><input type=\"radio\" name=\"q{i}\" value=\"{j}\"> {}</label>", esc(c.as_str().unwrap_or("")));
                }
                out += "</fieldset>";
            }
            out += "<button type=\"submit\">Rendre ma copie</button></form>";
        }
        Some(_) => {
            let ans: Value = a.get::<Option<Value>, _>("answers").unwrap_or(json!({}));
            out += &format!("<p><strong>Note : {}/{}</strong>{}</p><ol>", a.get::<Option<i32>, _>("score").unwrap_or(0), a.get::<Option<i32>, _>("max_score").unwrap_or(0),
                if a.get::<bool, _>("late") { " — copie rendue hors délai" } else { "" });
            for (i, q) in qs.iter().enumerate() {
                let ch = q["choices"].as_array().cloned().unwrap_or_default();
                let good = q["answer"].as_u64().unwrap_or(0) as usize;
                let given = ans.get(format!("q{i}")).and_then(Value::as_u64).map(|v| v as usize);
                let t = |k: usize| ch.get(k).and_then(Value::as_str).unwrap_or("—").to_string();
                let verdict = if given == Some(good) { "Correct" } else { "Incorrect" };
                out += &format!("<li>{} — <strong>{verdict}</strong>. Votre réponse : {} · Bonne réponse : {}</li>", esc(q["q"].as_str().unwrap_or("")),
                    esc(&given.map(t).unwrap_or_else(|| "sans réponse".into())), esc(&t(good)));
            }
            out += "</ol>";
        }
    }
    out += "</div><p><a href=\"/school/exams\">Mes examens blancs</a></p>";
    Ok(page(EX_T, &out))
}

/// Correction côté serveur : nombre de bonnes réponses (les réponses invalides comptent faux).
pub fn grade(questions: &[Value], f: &HashMap<String, String>) -> (i32, i32, Value) {
    let mut sc = 0; let mut ans = serde_json::Map::new();
    for (i, q) in questions.iter().enumerate() {
        let n = q["choices"].as_array().map(|c| c.len()).unwrap_or(0);
        if let Some(v) = f.get(&format!("q{i}")).and_then(|v| v.parse::<usize>().ok()).filter(|v| *v < n) {
            ans.insert(format!("q{i}"), json!(v));
            if q["answer"].as_u64() == Some(v as u64) { sc += 1; }
        }
    }
    (sc, questions.len() as i32, Value::Object(ans))
}

pub async fn ui_exam_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["start", "submit"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm, rbac::SCHOOL_ROLES, "school", "MOCK_EXAM").await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:exam:{}", u.id), 30, 60_000).await?;
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        if action == "start" {
            let ex = sqlx::query("SELECT duration_minutes FROM school_mock_exams WHERE exam_id=$1").bind(g("exam_id")).fetch_optional(&s.pool).await?
                .ok_or_else(|| AppError::new(404, "EXAM_NOT_FOUND", "Épreuve introuvable."))?;
            let id = crypto::create_id("att");
            let mut tx = rls_tx(&s, &u).await?;
            sqlx::query("INSERT INTO school_exam_attempts(attempt_id, exam_id, user_id, deadline_at) VALUES ($1,$2,$3, NOW() + make_interval(mins => $4))")
                .bind(&id).bind(g("exam_id")).bind(&u.id).bind(ex.get::<i32, _>("duration_minutes")).execute(&mut *tx).await.map_err(dbe)?;
            tx.commit().await?;
            audit::record(&s.pool, actor, "school", "MOCK_EXAM_STARTED", "exam_attempt", Some(&id), "SUCCESS", Some(&ip), json!({"exam": g("exam_id")})).await;
            return attempt_page(&s, &u, &tok, &id, Some("Épreuve commencée : le chronomètre tourne côté serveur.".into())).await;
        }
        let id = g("attempt_id");
        let mut tx = rls_tx(&s, &u).await?;
        let a = sqlx::query("SELECT a.deadline_at, a.submitted_at, e.questions FROM school_exam_attempts a JOIN school_mock_exams e USING (exam_id) WHERE a.attempt_id=$1 FOR UPDATE OF a")
            .bind(&id).fetch_optional(&mut *tx).await.map_err(dbe)?
            .ok_or_else(|| AppError::new(404, "ATTEMPT_NOT_FOUND", "Tentative introuvable."))?;
        if a.get::<Option<DateTime<Utc>>, _>("submitted_at").is_some() { return Err(AppError::new(409, "ALREADY_SUBMITTED", "Copie déjà rendue.")); }
        let qs: Value = a.get("questions");
        let (sc, max, ans) = grade(qs.as_array().map(Vec::as_slice).unwrap_or(&[]), &f);
        let late = Utc::now() > a.get::<DateTime<Utc>, _>("deadline_at") + Duration::seconds(EXAM_GRACE_S);
        sqlx::query("UPDATE school_exam_attempts SET submitted_at=NOW(), answers=$2, score=$3, max_score=$4, late=$5 WHERE attempt_id=$1")
            .bind(&id).bind(&ans).bind(sc).bind(max).bind(late).execute(&mut *tx).await.map_err(dbe)?;
        tx.commit().await?;
        audit::record(&s.pool, actor, "school", "MOCK_EXAM_SUBMITTED", "exam_attempt", Some(&id), "SUCCESS", Some(&ip), json!({"score": sc, "max": max, "late": late})).await;
        attempt_page(&s, &u, &tok, &id, Some(format!("Copie corrigée : {sc}/{max}."))).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(EX_T, "/school/exams", e) }
}

// ===================== T01 : parcours talent =====================
const TA_T: &str = "SOLOB Business — Parcours talent";
const TALENT_ROLES: &[&str] = &["contributor", "reviewer", "operator", "admin"];

pub async fn ui_talent(State(s): State<AppState>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async { let (u, tok) = session(&s, &hm, TALENT_ROLES, "business", "TALENT_JOURNEY").await?; talent_page(&s, &u, &tok, None).await }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(TA_T, "/business", e) }
}
async fn talent_page(s: &AppState, u: &rbac::AuthUser, tok: &str, fl: Option<String>) -> Result<String, AppError> {
    let hid = hidden(s, tok);
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    let mut tx = rls_tx(s, u).await?;
    if STAFF.contains(&u.role.as_str()) {
        let q = sqlx::query("SELECT user_id, skills, test_score, interview_answer, review_status, review_comment, trial_validated_at, badge_at FROM talent_journeys WHERE interview_submitted_at IS NOT NULL AND badge_at IS NULL ORDER BY interview_submitted_at")
            .fetch_all(&mut *tx).await.map_err(dbe)?;
        out += "<div class=\"card\"><h1>File de revue humaine</h1><p>Vous ne pouvez pas relire votre propre parcours.</p>";
        if q.is_empty() { out += "<p>Aucun parcours en attente.</p>"; }
        for r in q {
            let uid: String = r.get("user_id");
            let st: String = r.get("review_status");
            out += &format!("<div class=\"card\"><p><strong>{}</strong> — compétences : {} — test : {}/{}</p><p>Entretien : {}</p>", esc(&uid), esc(r.get("skills")),
                r.get::<Option<i32>, _>("test_score").unwrap_or(0), TALENT_TEST.len(), esc(r.get::<Option<String>, _>("interview_answer").as_deref().unwrap_or("")));
            if st == "approved" {
                out += &format!("<form method=\"post\" action=\"/talent/trial\">{hid}<input type=\"hidden\" name=\"user_id\" value=\"{}\"><button type=\"submit\">Valider l'essai supervisé et attribuer le badge</button></form>", esc(&uid));
            } else {
                out += &format!("<form method=\"post\" action=\"/talent/review\">{hid}<input type=\"hidden\" name=\"user_id\" value=\"{}\">\
<label>Décision<select name=\"decision\"><option value=\"approved\">Valider</option><option value=\"rejected\">Refuser</option></select></label>\
<label>Commentaire<textarea name=\"comment\" required maxlength=\"2000\"></textarea></label><button type=\"submit\">Enregistrer la revue</button></form>", esc(&uid));
                if st == "rejected" { out += &format!("<p>Revue précédente : refusé — {}</p>", esc(r.get::<Option<String>, _>("review_comment").as_deref().unwrap_or(""))); }
            }
            out += "</div>";
        }
        out += "</div>";
    }
    let j = sqlx::query("SELECT skills, test_score, test_passed_at, interview_submitted_at, review_status, review_comment, trial_validated_at, badge_at FROM talent_journeys WHERE user_id=$1")
        .bind(&u.id).fetch_optional(&mut *tx).await.map_err(dbe)?;
    tx.commit().await?;
    out += "<div class=\"card\"><h1>Mon parcours talent</h1><ol>\
<li>Test de compétences</li><li>Entretien IA (réponse écrite — placeholder)</li><li>Revue humaine</li><li>Essai supervisé</li><li>Badge</li></ol>";
    let passed = j.as_ref().and_then(|r| r.get::<Option<DateTime<Utc>>, _>("test_passed_at")).is_some();
    let interviewed = j.as_ref().and_then(|r| r.get::<Option<DateTime<Utc>>, _>("interview_submitted_at")).is_some();
    match j.as_ref().and_then(|r| r.get::<Option<DateTime<Utc>>, _>("badge_at")) {
        Some(b) => out += &format!("<p class=\"ok\"><strong>Badge obtenu</strong> le {}. Vous pouvez figurer dans les shortlists clients.</p>", local(b)),
        None if !passed => {
            if let Some(sc) = j.as_ref().and_then(|r| r.get::<Option<i32>, _>("test_score")) { out += &format!("<p>Dernier score : {sc}/{} (minimum {TALENT_PASS}).</p>", TALENT_TEST.len()); }
            out += &format!("<h2>Étape 1 — Test</h2><form method=\"post\" action=\"/talent/test\">{hid}<label>Compétences (ex. transcription fon, traduction)<input name=\"skills\" required maxlength=\"300\"></label>");
            for (i, (q, ch, _)) in TALENT_TEST.iter().enumerate() {
                out += &format!("<fieldset><legend>{}</legend>", esc(q));
                for (k, c) in ch.iter().enumerate() { out += &format!("<label><input type=\"radio\" name=\"t{i}\" value=\"{k}\"> {}</label>", esc(c)); }
                out += "</fieldset>";
            }
            out += "<button type=\"submit\">Valider le test</button></form>";
        }
        None if !interviewed => out += &format!("<h2>Étape 2 — Entretien IA</h2><p>Placeholder : décrivez une mission d'annotation réalisée et vos choix de qualité (50 à 4000 caractères). Un humain relira votre réponse.</p>\
<form method=\"post\" action=\"/talent/interview\">{hid}<textarea name=\"answer\" required minlength=\"50\" maxlength=\"4000\"></textarea><button type=\"submit\">Envoyer</button></form>"),
        None => {
            let r = j.as_ref().unwrap();
            let st: String = r.get("review_status");
            out += &match st.as_str() {
                "approved" => "<p>Revue humaine validée — essai supervisé en cours de validation.</p>".to_string(),
                "rejected" => format!("<p class=\"err\">Revue refusée : {}</p>", esc(r.get::<Option<String>, _>("review_comment").as_deref().unwrap_or(""))),
                _ => "<p>Entretien envoyé — en attente de revue humaine.</p>".to_string() };
        }
    }
    out += "</div><p><a href=\"/business\">Retour à Business</a></p>";
    Ok(page(TA_T, &out))
}

pub async fn ui_talent_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["test", "interview", "review", "trial"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm, TALENT_ROLES, "business", "TALENT_JOURNEY").await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:talent:{}", u.id), 20, 60_000).await?;
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let mut tx = rls_tx(&s, &u).await?;
        let msg = match action.as_str() {
            "test" => {
                let skills = g("skills");
                if skills.is_empty() || skills.chars().count() > 300 { return Err(AppError::new(400, "INVALID_SKILLS", "Indiquez vos compétences (1 à 300 caractères).")); }
                let sc = TALENT_TEST.iter().enumerate().filter(|(i, (_, _, a))| g(&format!("t{i}")).parse::<usize>().ok() == Some(*a)).count() as i32;
                let pass = sc >= TALENT_PASS;
                sqlx::query("INSERT INTO talent_journeys(user_id, skills, test_score, test_passed_at) VALUES ($1,$2,$3, CASE WHEN $4 THEN NOW() END)
                             ON CONFLICT (user_id) DO UPDATE SET skills=EXCLUDED.skills, test_score=EXCLUDED.test_score, test_passed_at=COALESCE(talent_journeys.test_passed_at, EXCLUDED.test_passed_at)")
                    .bind(&u.id).bind(&skills).bind(sc).bind(pass).execute(&mut *tx).await.map_err(dbe)?;
                audit::record(&s.pool, actor, "business", "TALENT_TEST", "talent_journey", Some(&u.id), "SUCCESS", Some(&ip), json!({"score": sc, "passed": pass})).await;
                if pass { format!("Test réussi ({sc}/{}).", TALENT_TEST.len()) } else { format!("Test non réussi ({sc}/{}) : vous pouvez réessayer.", TALENT_TEST.len()) }
            }
            "interview" => {
                let a = g("answer"); let n = a.chars().count();
                if !(50..=4000).contains(&n) { return Err(AppError::new(400, "INVALID_ANSWER", "La réponse doit faire entre 50 et 4000 caractères.")); }
                if let Some(m) = crate::contribute_ui::content_issue(&a) { return Err(AppError::new(400, "CONTENT_REJECTED", m)); }
                let n = sqlx::query("UPDATE talent_journeys SET interview_answer=$2, interview_submitted_at=NOW(), review_status='none' WHERE user_id=$1 AND badge_at IS NULL")
                    .bind(&u.id).bind(&a).execute(&mut *tx).await.map_err(dbe)?.rows_affected();
                if n == 0 { return Err(AppError::new(409, "STEP_ORDER", "Étape refusée : l'étape précédente n'est pas validée.")); }
                audit::record(&s.pool, actor, "business", "TALENT_INTERVIEW", "talent_journey", Some(&u.id), "SUCCESS", Some(&ip), json!({})).await;
                "Entretien envoyé : un relecteur humain va l'examiner.".into()
            }
            _ => {
                if !STAFF.contains(&u.role.as_str()) {
                    audit::record(&s.pool, actor, "business", "TALENT_REVIEW", "talent_journey", None, "DENIED", Some(&ip), json!({"reason": "role"})).await;
                    return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé aux relecteurs."));
                }
                let target = g("user_id");
                let n = if action == "review" {
                    let d = g("decision"); let c = g("comment");
                    if !["approved", "rejected"].contains(&d.as_str()) || c.is_empty() || c.chars().count() > 2000 { return Err(AppError::new(400, "INVALID_REVIEW", "Décision et commentaire obligatoires.")); }
                    sqlx::query("UPDATE talent_journeys SET review_status=$2, review_comment=$3, reviewer_id=$4, reviewed_at=NOW() WHERE user_id=$1 AND badge_at IS NULL")
                        .bind(&target).bind(&d).bind(&c).bind(&u.id).execute(&mut *tx).await.map_err(dbe)?.rows_affected()
                } else {
                    sqlx::query("UPDATE talent_journeys SET trial_validator_id=$2, trial_validated_at=NOW(), badge_at=NOW() WHERE user_id=$1 AND badge_at IS NULL")
                        .bind(&target).bind(&u.id).execute(&mut *tx).await.map_err(dbe)?.rows_affected()
                };
                if n == 0 { return Err(AppError::new(404, "JOURNEY_NOT_FOUND", "Parcours introuvable ou déjà badgé.")); }
                audit::record(&s.pool, actor, "business", if action == "review" { "TALENT_REVIEW" } else { "TALENT_BADGE_AWARDED" }, "talent_journey", Some(&target), "SUCCESS", Some(&ip), json!({"decision": g("decision")})).await;
                if action == "review" { "Revue enregistrée.".into() } else { "Essai supervisé validé : badge attribué.".into() }
            }
        };
        tx.commit().await?;
        talent_page(&s, &u, &tok, Some(msg)).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(TA_T, "/talent", e) }
}

// ===================== C01 / C02 : demande client, appel, shortlist =====================
const CL_T: &str = "SOLOB Business — Espace client";
pub(crate) const CLIENT_ROLES: &[&str] = &["org_client", "reviewer", "operator", "admin"];

/// Créneau d'appel de 15 min saisi à l'heure du Bénin : jours ouvrés, 09:00–16:45, quarts d'heure, au moins 2 h à l'avance.
pub fn parse_slot(v: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, AppError> {
    let bad = |m: &str| AppError::new(400, "INVALID_SLOT", m);
    let n = NaiveDateTime::parse_from_str(v, "%Y-%m-%dT%H:%M").map_err(|_| bad("Date et heure invalides."))?;
    if n.weekday().number_from_monday() > 5 { return Err(bad("Les appels ont lieu du lundi au vendredi.")); }
    if n.hour() < 9 || n.hour() > 16 || n.minute() % 15 != 0 { return Err(bad("Créneaux de 15 min entre 09:00 et 16:45 (heure du Bénin).")); }
    let t = n.and_utc() - Duration::hours(LOCAL_OFFSET_H);
    if t < now + Duration::hours(2) { return Err(bad("Réservez au moins 2 h à l'avance.")); }
    if t > now + Duration::days(60) { return Err(bad("Réservez dans les 60 prochains jours.")); }
    Ok(t)
}

pub async fn ui_client(State(s): State<AppState>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async { let (u, tok) = session(&s, &hm, CLIENT_ROLES, "business", "CLIENT_REQUEST").await?; client_page(&s, &u, &tok, None).await }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(CL_T, "/business", e) }
}
async fn client_page(s: &AppState, u: &rbac::AuthUser, tok: &str, fl: Option<String>) -> Result<String, AppError> {
    let hid = hidden(s, tok);
    let staff = STAFF.contains(&u.role.as_str());
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    if !staff {
        let tzo: String = (-12..=14).map(|h: i64| format!("<option value=\"{h}\"{}>UTC{}{}</option>", if h == LOCAL_OFFSET_H { " selected" } else { "" }, if h < 0 { "−" } else { "+" }, h.abs())).collect();
        out += &format!("<div class=\"card\"><h1>Décrire mon besoin</h1><form method=\"post\" action=\"/client/request\">{hid}\
<label>Besoin (10 à 4000 caractères)<textarea name=\"need\" required minlength=\"10\" maxlength=\"4000\"></textarea></label>\
<label>Compétences recherchées<input name=\"skills\" maxlength=\"300\"></label>\
<label>Appel de 15 min — date et heure (heure du Bénin, UTC+1, lun.–ven. 09:00–16:45)<input type=\"datetime-local\" name=\"call_at\" step=\"900\" required></label>\
<label>Mon fuseau horaire (pour l'affichage)<select name=\"tz\">{tzo}</select></label><button type=\"submit\">Envoyer et réserver l'appel</button></form></div>");
    }
    let mut tx = rls_tx(s, u).await?;
    let reqs = sqlx::query("SELECT request_id, client_id, need, skills, call_at, client_tz, status FROM client_requests ORDER BY created_at DESC LIMIT 50").fetch_all(&mut *tx).await.map_err(dbe)?;
    let sl = sqlx::query("SELECT request_id, talent_user_id, note FROM client_shortlists ORDER BY created_at").fetch_all(&mut *tx).await.map_err(dbe)?;
    tx.commit().await?;
    let badged: Vec<(String, String, String)> = if staff {
        sqlx::query_as("SELECT j.user_id, u.full_name, j.skills FROM talent_journeys j JOIN users u ON u.id=j.user_id WHERE j.badge_at IS NOT NULL ORDER BY u.full_name").fetch_all(&s.pool).await?
    } else { vec![] };
    out += &format!("<div class=\"card\"><h1>{}</h1>", if staff { "Demandes clients" } else { "Mes demandes" });
    if reqs.is_empty() { out += "<p>Aucune demande.</p>"; }
    for r in reqs {
        let rid: String = r.get("request_id");
        let tz: i64 = r.get::<String, _>("client_tz").strip_prefix("UTC").and_then(|v| v.parse().ok()).unwrap_or(LOCAL_OFFSET_H);
        out += &format!("<div class=\"card\"><p><strong>Appel :</strong> {} — fuseau du client : {} — statut : {}</p><p>{}</p><p>Compétences : {}</p>", local(r.get("call_at")), in_tz(r.get("call_at"), tz), esc(r.get("status")), esc(r.get("need")), esc(r.get("skills")));
        let mine: Vec<_> = sl.iter().filter(|x| x.get::<String, _>("request_id") == rid).collect();
        out += "<h3>Shortlist</h3>";
        if mine.is_empty() { out += "<p>En préparation.</p>"; }
        else {
            out += "<ul>";
            for x in mine {
                let tid: String = x.get("talent_user_id");
                // Compétences vérifiées : uniquement celles du parcours badgé (lecture propriétaire, la shortlist ne contient que des badgés).
                let info: Option<(String, String)> = sqlx::query_as("SELECT u.full_name, j.skills FROM talent_journeys j JOIN users u ON u.id=j.user_id WHERE j.user_id=$1 AND j.badge_at IS NOT NULL")
                    .bind(&tid).fetch_optional(&s.pool).await?;
                let (n, sk) = info.unwrap_or_default();
                out += &format!("<li><strong>{}</strong> — badge SOLOB vérifié — compétences : {} {}</li>", esc(&n), esc(&sk), esc(x.get("note")));
            }
            out += "</ul>";
        }
        if staff && !badged.is_empty() {
            let opts: String = badged.iter().map(|(id, n, sk)| format!("<option value=\"{}\">{} — {}</option>", esc(id), esc(n), esc(sk))).collect();
            out += &format!("<form method=\"post\" action=\"/client/shortlist\">{hid}<input type=\"hidden\" name=\"request_id\" value=\"{}\">\
<label>Talent badgé<select name=\"talent_user_id\">{opts}</select></label><label>Note<input name=\"note\" maxlength=\"300\"></label><button type=\"submit\">Ajouter à la shortlist</button></form>", esc(&rid));
        }
        out += "</div>";
    }
    out += "</div><p><a href=\"/enterprise/quotes\">Demander un devis (tarification sur devis)</a> · <a href=\"/business\">Retour à Business</a></p>";
    Ok(page(CL_T, &out))
}

pub async fn ui_client_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        if !["request", "shortlist"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Action inconnue.")); }
        let (u, tok) = session(&s, &hm, CLIENT_ROLES, "business", "CLIENT_REQUEST").await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:client:{}", u.id), 20, 60_000).await?;
        let actor = Some((u.id.as_str(), u.role.as_str()));
        let g = |k: &str| f.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
        let staff = STAFF.contains(&u.role.as_str());
        let mut tx = rls_tx(&s, &u).await?;
        let msg = if action == "request" {
            if staff { return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé aux clients.")); }
            let need = g("need"); let n = need.chars().count();
            if !(10..=4000).contains(&n) { return Err(AppError::new(400, "INVALID_NEED", "Décrivez le besoin (10 à 4000 caractères).")); }
            if g("skills").chars().count() > 300 { return Err(AppError::new(400, "INVALID_SKILLS", "Compétences : 300 caractères maximum.")); }
            let at = parse_slot(&g("call_at"), Utc::now())?;
            let tz = parse_tz(&g("tz"))?;
            let id = crypto::create_id("creq");
            sqlx::query("INSERT INTO client_requests(request_id, client_id, need, skills, call_at, client_tz) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(&id).bind(&u.id).bind(&need).bind(g("skills")).bind(at).bind(format!("UTC{tz:+}")).execute(&mut *tx).await.map_err(dbe)?;
            audit::record(&s.pool, actor, "business", "CLIENT_REQUEST_CREATED", "client_request", Some(&id), "SUCCESS", Some(&ip), json!({"call_at": at.to_rfc3339()})).await;
            format!("Demande enregistrée. Appel de 15 min confirmé le {} — dans votre fuseau : {} (soit {} UTC).", local(at), in_tz(at, tz), at.format("%d/%m/%Y %H:%M"))
        } else {
            if !staff {
                audit::record(&s.pool, actor, "business", "CLIENT_SHORTLIST_ADD", "client_request", None, "DENIED", Some(&ip), json!({"reason": "role"})).await;
                return Err(AppError::new(403, "FORBIDDEN_ROLE", "Réservé à l'équipe SOLOB."));
            }
            let (rid, tid) = (g("request_id"), g("talent_user_id"));
            sqlx::query("INSERT INTO client_shortlists(request_id, talent_user_id, added_by, note) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
                .bind(&rid).bind(&tid).bind(&u.id).bind(g("note").chars().take(300).collect::<String>()).execute(&mut *tx).await.map_err(dbe)?;
            sqlx::query("UPDATE client_requests SET status='shortlist_sent' WHERE request_id=$1").bind(&rid).execute(&mut *tx).await.map_err(dbe)?;
            audit::record(&s.pool, actor, "business", "CLIENT_SHORTLIST_ADD", "client_request", Some(&rid), "SUCCESS", Some(&ip), json!({"talent": tid})).await;
            "Talent ajouté à la shortlist.".into()
        };
        tx.commit().await?;
        client_page(&s, &u, &tok, Some(msg)).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(CL_T, "/client", e) }
}

// ===================== P02 : demande de suppression de compte =====================
const DE_T: &str = "SOLOB — Suppression de compte";
pub async fn ui_deletion(State(s): State<AppState>, hm: HeaderMap) -> Response {
    let r: Result<String, AppError> = async { let (u, tok) = session(&s, &hm, rbac::ALL_ROLES, "core", "ACCOUNT_DELETION").await?; deletion_page(&s, &u, &tok, None).await }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(DE_T, "/account", e) }
}
async fn deletion_page(s: &AppState, u: &rbac::AuthUser, tok: &str, fl: Option<String>) -> Result<String, AppError> {
    let mut out = fl.map(|m| flash(&m)).unwrap_or_default();
    let pend: Option<(String, Option<DateTime<Utc>>, DateTime<Utc>)> = sqlx::query_as("SELECT status, due_at, created_at FROM privacy_requests WHERE user_id=$1 AND request_type='ACCOUNT_DELETION_REQUEST' ORDER BY created_at DESC LIMIT 1")
        .bind(&u.id).fetch_optional(&s.pool).await?;
    out += &format!("<div class=\"card\"><h1>Supprimer mon compte</h1><p>Votre demande est enregistrée et journalisée, puis traitée par l'équipe SOLOB sous {DELETION_DUE_DAYS} jours au plus. Exportez d'abord vos données depuis <a href=\"/account\">Mon compte</a> si besoin.</p>");
    match pend {
        Some((st, due, at)) if st == "PENDING_REVIEW" => out += &format!("<p class=\"ok\">Demande reçue le {} — traitement au plus tard le {}.</p>", local(at), due.map(local).unwrap_or_default()),
        _ => out += &format!("<form method=\"post\" action=\"/account/deletion\">{}<label><input type=\"checkbox\" name=\"confirm\" value=\"yes\" required> Je confirme vouloir supprimer mon compte</label><button type=\"submit\">Demander la suppression</button></form>", hidden(s, tok)),
    }
    out += "</div>";
    Ok(page(DE_T, &out))
}
pub async fn ui_deletion_post(State(s): State<AppState>, hm: HeaderMap, axum::Form(f): axum::Form<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        let (u, tok) = session(&s, &hm, rbac::ALL_ROLES, "core", "ACCOUNT_DELETION").await?;
        check_post(&s, &hm, &tok, &f)?;
        let ip = h::client_key(&s.cfg, &hm);
        rate_limit::enforce(&s.pool, &format!("ui:deletion:{}", u.id), 5, 60_000).await?;
        if f.get("confirm").map(String::as_str) != Some("yes") { return Err(AppError::new(400, "CONFIRM_REQUIRED", "Cochez la confirmation.")); }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=$1 AND request_type='ACCOUNT_DELETION_REQUEST' AND status='PENDING_REVIEW')").bind(&u.id).fetch_one(&s.pool).await?;
        if !exists {
            let id = crypto::create_id("priv");
            sqlx::query("INSERT INTO privacy_requests(id, user_id, request_type, status, payload_json, due_at) VALUES ($1,$2,'ACCOUNT_DELETION_REQUEST','PENDING_REVIEW',$3, NOW() + make_interval(days => $4))")
                .bind(&id).bind(&u.id).bind(json!({"channel": "ui"})).bind(DELETION_DUE_DAYS as i32).execute(&s.pool).await?;
            audit::record(&s.pool, Some((&u.id, &u.role)), "core", "ACCOUNT_DELETION_REQUESTED", "privacy_request", Some(&id), "SUCCESS", Some(&ip), json!({"due_days": DELETION_DUE_DAYS})).await;
        }
        deletion_page(&s, &u, &tok, Some("Demande de suppression enregistrée.".into())).await
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(DE_T, "/account/deletion", e) }
}

// ===================== Recherche plein texte (français) =====================
const SE_T: &str = "SOLOB — Recherche";
pub async fn ui_search(State(s): State<AppState>, hm: HeaderMap, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>) -> Response {
    let r: Result<String, AppError> = async {
        let tok = h::session_token(&hm);
        let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
        rbac::check_role(u.as_ref(), rbac::ALL_ROLES, "core", "SEARCH")?;
        let u = u.unwrap();
        let term = q.get("q").map(|v| v.trim().chars().take(200).collect::<String>()).unwrap_or_default();
        let mut out = format!("<div class=\"card\"><h1>Recherche</h1><form method=\"get\" action=\"/search\"><label>Mots-clés<input name=\"q\" value=\"{}\" maxlength=\"200\"></label><button type=\"submit\">Chercher</button></form></div>", esc(&term));
        if !term.is_empty() {
            rate_limit::enforce(&s.pool, &format!("ui:search:{}", u.id), 30, 60_000).await?;
            let lib: Vec<(String, String, String)> = if sqlx::query_scalar::<_, bool>("SELECT to_regclass('public.sakc_resources') IS NOT NULL").fetch_one(&s.pool).await? {
                sqlx::query_as("SELECT title, discipline, level FROM sakc_resources WHERE rights_status='rights_verified' AND to_tsvector('french', coalesce(title,'') || ' ' || discipline || ' ' || level) @@ websearch_to_tsquery('french', $1)
                                ORDER BY ts_rank(to_tsvector('french', coalesce(title,'') || ' ' || discipline || ' ' || level), websearch_to_tsquery('french', $1)) DESC LIMIT 20").bind(&term).fetch_all(&s.pool).await?
            } else { vec![] };
            out += "<div class=\"card\"><h2>Bibliothèque (droits vérifiés)</h2>";
            if lib.is_empty() { out += "<p>Aucun résultat.</p>"; }
            for (t, d, l) in lib { out += &format!("<p>{} — {} · {}</p>", esc(&t), esc(&d), esc(&l)); }
            out += "</div>";
            if rbac::BUSINESS_ROLES.contains(&u.role.as_str()) {
                let sql = if STAFF.contains(&u.role.as_str()) { "SELECT title, status FROM business_projects WHERE to_tsvector('french', title) @@ websearch_to_tsquery('french', $1) LIMIT 20" }
                          else { "SELECT title, status FROM business_projects WHERE client_user_id=$2 AND to_tsvector('french', title) @@ websearch_to_tsquery('french', $1) LIMIT 20" };
                let ms: Vec<(String, String)> = sqlx::query_as(sql).bind(&term).bind(&u.id).fetch_all(&s.pool).await?;
                out += "<div class=\"card\"><h2>Missions</h2>";
                if ms.is_empty() { out += "<p>Aucun résultat.</p>"; }
                for (t, st) in ms { out += &format!("<p>{} — {}</p>", esc(&t), esc(&st)); }
                out += "</div>";
            }
        }
        Ok(page(SE_T, &out))
    }.await;
    match r { Ok(b) => html(200, b), Err(e) => err_page(SE_T, "/", e) }
}
