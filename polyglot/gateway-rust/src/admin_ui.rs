//! Server-rendered admin console (/admin, admin + operator) and personal privacy page (/account, any signed-in user).
//! Same pipeline as School/Business forms: session → RBAC → CSRF HMAC bound to the session → rate limit → audited action.
use crate::{admin, app::AppState, crypto, error::AppError, http as h, rate_limit, rbac, ui::esc};
use axum::{extract::{Path, State}, http::{header, HeaderMap, Method, StatusCode}, response::{IntoResponse, Response}};
use serde_json::{json, Value};
use std::collections::HashMap;

fn html(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}
fn s_(v: &Value, k: &str) -> String { match v.get(k) { Some(Value::String(x)) => x.clone(), Some(Value::Null) | None => String::new(), Some(x) => x.to_string() } }
fn arr(v: &Value) -> Vec<Value> { v.as_array().cloned().unwrap_or_default() }

async fn session(s: &AppState, hm: &HeaderMap, allowed: &[&str]) -> Result<(rbac::AuthUser, String), AppError> {
    let tok = h::session_token(hm);
    let u = crate::auth::authenticate(&s.pool, &s.cfg, tok.as_deref()).await?;
    rbac::check_role(u.as_ref(), allowed, "core", "UI")?;
    Ok((u.unwrap(), tok.unwrap()))
}
fn check_csrf(s: &AppState, hm: &HeaderMap, tok: &str, f: &HashMap<String, String>) -> Result<(), AppError> {
    let csrf = f.get("csrf").map(String::as_str).unwrap_or("");
    h::enforce_csrf(&Method::POST, hm, Some(csrf))?;
    if !crypto::verify_csrf_token(&s.cfg.session_secret, tok, csrf) { return Err(AppError::new(403, "CSRF_VALIDATION_FAILED", "Invalid CSRF token.")); }
    Ok(())
}
fn flash(f: Option<(bool, String)>) -> String {
    f.map(|(ok, m)| format!("<div class=\"card {}\" role=\"status\">{}</div>", if ok { "ok" } else { "err" }, esc(&m))).unwrap_or_default()
}

pub async fn render_admin(s: &AppState, u: &rbac::AuthUser, tok: &str, fl: Option<(bool, String)>) -> Result<String, AppError> {
    let hidden = format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)));
    let ov = admin::overview(&s.pool, &s.cfg, Some(u)).await?;
    let is_admin = u.role == "admin";
    let c = &ov["counts"]; let env = &ov["environmentStatus"];
    let mut out = flash(fl);
    out += &format!("<div class=\"card\"><h2>Environnement</h2><p>Mode : <strong>{}</strong> — IA : {} — Paiements : <strong>{}</strong></p>\
<p>Utilisateurs : {} · Documents School : {} · Projets Business : {} · Tâches : {}</p></div>",
        esc(&s_(env, "appEnv")), esc(&s_(env, "aiMode")), esc(&s_(env, "paymentMode")), esc(&s_(c, "users_count")), esc(&s_(c, "school_docs_count")),
        esc(&s_(c, "business_projects_count")), esc(&s_(c, "tasks_count")));
    out += "<div class=\"card\"><h2>Feature flags</h2><table><tr><th>Clé</th><th>Pilier</th><th>État</th><th></th></tr>";
    for f in arr(&ov["featureFlags"]) {
        let on = f["enabled"].as_bool() == Some(true);
        let btn = if is_admin { format!("<form method=\"post\" action=\"/admin/toggle_flag\">{hidden}<input type=\"hidden\" name=\"key\" value=\"{}\"><input type=\"hidden\" name=\"enabled\" value=\"{}\"><button>{}</button></form>",
            esc(&s_(&f, "key")), !on, if on { "Désactiver" } else { "Activer" }) } else { String::new() };
        out += &format!("<tr><td><strong>{}</strong><br><small>{}</small></td><td>{}</td><td>{}</td><td>{btn}</td></tr>", esc(&s_(&f, "key")), esc(&s_(&f, "description")), esc(&s_(&f, "pillar")), if on { "activé" } else { "désactivé" });
    }
    out += "</table></div>";
    let roles: &[&str] = if is_admin { rbac::ALL_ROLES } else { &["student", "teacher", "org_client", "contributor", "reviewer"] };
    out += &format!("<div class=\"card\"><h2>Provisionner un utilisateur vérifié</h2><form method=\"post\" action=\"/admin/provision_user\">{hidden}\
<label>Email<input name=\"email\" type=\"email\" required maxlength=\"180\"></label><label>Mot de passe initial<input name=\"password\" type=\"password\" required minlength=\"8\" maxlength=\"128\" autocomplete=\"new-password\"></label>\
<label>Nom complet<input name=\"fullName\" required minlength=\"2\" maxlength=\"120\"></label><label>Rôle<select name=\"role\">{}</select></label>\
<label>Pays<input name=\"countryCode\" value=\"BJ\" maxlength=\"4\"></label><button>Créer</button></form></div>",
        roles.iter().map(|r| format!("<option>{r}</option>")).collect::<String>());
    if is_admin && !s.cfg.production {
        out += &format!("<div class=\"card\"><h2>Données synthétiques (dev/test uniquement)</h2><p>Crée des comptes <code>@synthetic.solob.local</code> clairement étiquetés [SYNTHETIC]. Refusé en production.</p>\
<form method=\"post\" action=\"/admin/seed_synthetic\">{hidden}<button>Générer les données synthétiques</button></form></div>");
    }
    let d = &ov["adminDetails"];
    out += "<div class=\"card\"><h2>Utilisateurs récents</h2><table><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>Pays</th></tr>";
    for x in arr(&d["users"]).iter().take(20) { out += &format!("<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>", esc(&s_(x, "full_name")), esc(&s_(x, "email")), esc(&s_(x, "role")), esc(&s_(x, "country_code"))); }
    out += "</table></div><div class=\"card\"><h2>Journal d'audit (20 derniers)</h2><table><tr><th>Date</th><th>Action</th><th>Rôle</th><th>Statut</th></tr>";
    for x in arr(&d["recentAudits"]).iter().take(20) { out += &format!("<tr><td><small>{}</small></td><td>{}</td><td>{}</td><td>{}</td></tr>", esc(&s_(x, "created_at")), esc(&s_(x, "action")), esc(&s_(x, "actor_role")), esc(&s_(x, "status"))); }
    out += "</table></div>";
    Ok(crate::ui::page("SOLOB Core — Administration", &format!("<div class=\"card\"><h1>SOLOB Core — Administration</h1><p>Console de {} ({}). <a href=\"/account\">Mes données</a></p></div>{out}", esc(&u.full_name), esc(&u.role))))
}

pub async fn ui_admin(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    match session(&s, &hm, rbac::OPERATOR_ROLES).await {
        Ok((u, tok)) => Ok(html(200, render_admin(&s, &u, &tok, None).await?)),
        Err(e) => Ok(html(e.status, crate::ui::pillar("SOLOB Core — Administration", None, Some(e.message)))),
    }
}

pub async fn ui_admin_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                             axum::Form(f): axum::Form<HashMap<String, String>>) -> Result<Response, AppError> {
    if !["seed_synthetic", "provision_user", "toggle_flag"].contains(&action.as_str()) { return Err(AppError::new(404, "UNKNOWN_ACTION", "Unknown admin action.")); }
    let (u, tok) = session(&s, &hm, rbac::OPERATOR_ROLES).await?;
    check_csrf(&s, &hm, &tok, &f)?;
    let ip = h::client_key(&s.cfg, &hm);
    rate_limit::enforce(&s.pool, &format!("api:admin:{ip}"), 30, 60_000).await?;
    let g = |k: &str| f.get(k).cloned().unwrap_or_default();
    let r = match action.as_str() {
        "toggle_flag" => admin::toggle_flag(&s.pool, Some(&u), &g("key"), g("enabled") == "true").await.map(|_| "Flag mis à jour.".to_string()),
        "provision_user" => admin::provision_user(&s.pool, &s.cfg, Some(&u), &json!({"email": g("email"), "password": g("password"), "fullName": g("fullName"),
            "role": g("role"), "countryCode": g("countryCode")}), &ip).await.map(|n| format!("Utilisateur {} créé ({}).", n.email, n.role)),
        _ => admin::seed_synthetic(&s, Some(&u)).await.map(|v| if v["alreadySeeded"] == true { "Données synthétiques déjà présentes.".into() } else { "Données synthétiques créées.".into() }),
    };
    let (st, fl) = match r { Ok(m) => (200, (true, m)), Err(e) => (e.status, (false, format!("Erreur {} : {}", e.code, e.message))) };
    Ok(html(st, render_admin(&s, &u, &tok, Some(fl)).await?))
}

fn render_account(s: &AppState, u: &rbac::AuthUser, tok: &str, fl: Option<(bool, String)>) -> String {
    let hidden = format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", esc(&crypto::derive_csrf_token(&s.cfg.session_secret, tok)));
    crate::ui::page("Mes données", &format!("<div class=\"card\"><h1>Mes données et consentements</h1><p>{} ({})</p></div>{}\
<div class=\"card\"><h2>Confidentialité</h2><form method=\"post\" action=\"/account/update_privacy\">{hidden}\
<label>Durée de conservation (jours, 30–3650)<input name=\"privacyRetentionDays\" type=\"number\" min=\"30\" max=\"3650\" value=\"365\"></label>\
<label><input type=\"checkbox\" name=\"marketingConsent\" value=\"true\"> Communications marketing</label>\
<label><input type=\"checkbox\" name=\"voiceDataConsent\" value=\"true\"> Données vocales</label>\
<label><input type=\"checkbox\" name=\"linguisticDataConsent\" value=\"true\"> Données linguistiques</label><button>Enregistrer</button></form></div>\
<div class=\"card\"><h2>Export (portabilité)</h2><form method=\"post\" action=\"/account/export_data\">{hidden}<button>Télécharger mes données (JSON)</button></form></div>",
        esc(&u.full_name), esc(&u.role), flash(fl)))
}

pub async fn ui_account(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    match session(&s, &hm, rbac::ALL_ROLES).await {
        Ok((u, tok)) => Ok(html(200, render_account(&s, &u, &tok, None))),
        Err(e) => Ok(html(e.status, crate::ui::pillar("Mes données", None, Some(e.message)))),
    }
}

pub async fn ui_account_action(State(s): State<AppState>, Path(action): Path<String>, hm: HeaderMap,
                               axum::Form(f): axum::Form<HashMap<String, String>>) -> Result<Response, AppError> {
    let (u, tok) = session(&s, &hm, rbac::ALL_ROLES).await?;
    check_csrf(&s, &hm, &tok, &f)?;
    rate_limit::enforce(&s.pool, &format!("core:mutation:user:{}", u.id), 60, 60_000).await?;
    match action.as_str() {
        "update_privacy" => {
            let chk = |k: &str| f.get(k).map(|v| v == "true").unwrap_or(false);
            let days = f.get("privacyRetentionDays").and_then(|v| v.trim().parse::<i64>().ok());
            let r = admin::update_privacy(&s.pool, &u, &json!({"privacyRetentionDays": days, "marketingConsent": chk("marketingConsent"),
                "voiceDataConsent": chk("voiceDataConsent"), "linguisticDataConsent": chk("linguisticDataConsent")})).await;
            let (st, fl) = match r { Ok(_) => (200, (true, "Préférences enregistrées.".to_string())), Err(e) => (e.status, (false, format!("Erreur {} : {}", e.code, e.message))) };
            Ok(html(st, render_account(&s, &u, &tok, Some(fl))))
        }
        "export_data" => {
            let pkg = admin::export_data(&s.pool, &u).await?;
            Ok(([(header::CONTENT_TYPE, "application/json".to_string()), (header::CONTENT_DISPOSITION, "attachment; filename=\"solob-export.json\"".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string())], serde_json::to_string_pretty(&pkg).unwrap()).into_response())
        }
        _ => Err(AppError::new(404, "UNKNOWN_ACTION", "Unknown account action.")),
    }
}
