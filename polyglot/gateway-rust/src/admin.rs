//! SOLOB Core administration (mirrors src/lib/core/admin.ts, src/lib/db/seed.ts and the privacy/export/provision
//! parts of src/lib/core/auth.ts). Every mutation is RBAC-checked here and audited.
use crate::{app::AppState, audit, auth, config::Config, crypto, error::AppError, rbac::{self, AuthUser}};
use serde_json::{json, Value};
use sqlx::PgPool;

pub const SYNTHETIC_PASSWORD: &str = "SolobSynthetic#2026";

pub const DEFAULT_FLAGS: &[(&str, &str, bool, &str)] = &[
    ("school.grounded_ai_tutor", "Enable source-grounded academic explanations with uncertainty badges", true, "school"),
    ("school.teacher_assessment_builder", "Allow teachers to generate and customize marking rubrics", true, "school"),
    ("business.explainable_talent_matching", "Enable explainable multi-factor language/skill matching for operators", true, "business"),
    ("business.live_payment_transfers", "Live payment provider transfers (MUST remain disabled unless certified provider is configured)", false, "business"),
    ("core.strict_audit_redaction", "Automatically redact secrets, tokens, and passwords in audit logs", true, "core"),
];

/// Idempotent reference-data insert (TS did it in ensureDbReady).
pub async fn ensure_flags(pool: &PgPool) -> Result<(), AppError> {
    for (k, d, e, p) in DEFAULT_FLAGS {
        sqlx::query("INSERT INTO feature_flags (key, description, enabled, pillar) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING")
            .bind(k).bind(d).bind(e).bind(p).execute(pool).await?;
    }
    Ok(())
}

async fn rows(pool: &PgPool, sql: &str, uid: Option<&str>) -> Result<Value, AppError> {
    let q = format!("SELECT COALESCE(json_agg(t), '[]'::json) FROM ({sql}) t");
    let mut qq = sqlx::query_scalar::<_, Value>(&q);
    if let Some(u) = uid { qq = qq.bind(u); }
    Ok(qq.fetch_one(pool).await?)
}

fn payment_mode() -> &'static str {
    match std::env::var("PAYMENT_PROVIDER").ok().as_deref() { None | Some("") | Some("disabled") => "DISABLED_NO_LIVE_TRANSFER", _ => "SANDBOX_SIMULATED" }
}

pub async fn overview(pool: &PgPool, cfg: &Config, user: Option<&AuthUser>) -> Result<Value, AppError> {
    ensure_flags(pool).await?;
    let counts = sqlx::query_scalar::<_, Value>("SELECT json_build_object(
        'users_count', (SELECT COUNT(*)::text FROM users), 'school_docs_count', (SELECT COUNT(*)::text FROM school_documents),
        'business_projects_count', (SELECT COUNT(*)::text FROM business_projects), 'tasks_count', (SELECT COUNT(*)::text FROM business_tasks))")
        .fetch_one(pool).await?;
    let admin_details = match user {
        Some(u) if u.role == "admin" || u.role == "operator" => json!({
            "recentAudits": rows(pool, "SELECT id, actor_user_id, actor_role, pillar, action, target_type, target_id, status, created_at FROM audit_events ORDER BY created_at DESC LIMIT 40", None).await?,
            "aiUsageSummary": sqlx::query_scalar::<_, Value>("SELECT json_build_object('total_calls', COUNT(*)::int, 'total_prompt_tokens', COALESCE(SUM(prompt_tokens),0)::int,
                'total_completion_tokens', COALESCE(SUM(completion_tokens),0)::int, 'total_cost_usd', COALESCE(SUM(estimated_cost_usd),0)::numeric(10,6)) FROM ai_usage_records").fetch_one(pool).await?,
            "users": rows(pool, "SELECT id, email, full_name, role, pillar, country_code, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 50", None).await?,
        }),
        _ => Value::Null,
    };
    let notifications = match user { Some(u) => rows(pool, "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15", Some(&u.id)).await?, None => json!([]) };
    Ok(json!({
        "engineType": "postgres",
        "environmentStatus": {"appEnv": if cfg.production {"production"} else {"development"}, "isProduction": cfg.production,
            "allowSyntheticQuickSwitch": !cfg.production, "aiMode": "MOCK_DEMO", "paymentMode": payment_mode()},
        "counts": counts,
        "languages": rows(pool, "SELECT * FROM languages_registry ORDER BY code ASC", None).await?,
        "featureFlags": rows(pool, "SELECT * FROM feature_flags ORDER BY key ASC", None).await?,
        "notifications": notifications,
        "adminDetails": admin_details,
    }))
}

pub async fn toggle_flag(pool: &PgPool, actor: Option<&AuthUser>, key: &str, enabled: bool) -> Result<Value, AppError> {
    let a = enforce(pool, actor, &["admin"], "TOGGLE_FEATURE_FLAG").await?;
    ensure_flags(pool).await?;
    if key == "business.live_payment_transfers" && enabled && payment_mode() == "DISABLED_NO_LIVE_TRANSFER" {
        audit::record(pool, Some((&a.id, &a.role)), "core", "FEATURE_FLAG_TOGGLED", "feature_flag", Some(key), "DENIED", None,
            json!({"key": key, "enabled": enabled, "reason": "LIVE_PAYMENT_PROVIDER_DISABLED"})).await;
        return Err(AppError::new(400, "LIVE_PAYMENT_PROVIDER_DISABLED", "Cannot enable business.live_payment_transfers while PAYMENT_PROVIDER is disabled."));
    }
    let n = sqlx::query("UPDATE feature_flags SET enabled = $2, updated_at = NOW() WHERE key = $1").bind(key).bind(enabled).execute(pool).await?.rows_affected();
    if n == 0 { return Err(AppError::new(404, "FLAG_NOT_FOUND", "Unknown feature flag.")); }
    audit::record(pool, Some((&a.id, &a.role)), "core", "FEATURE_FLAG_TOGGLED", "feature_flag", Some(key), "SUCCESS", None, json!({"key": key, "enabled": enabled})).await;
    Ok(sqlx::query_scalar::<_, Value>("SELECT row_to_json(f) FROM feature_flags f WHERE key = $1").bind(key).fetch_one(pool).await?)
}

async fn enforce(pool: &PgPool, actor: Option<&AuthUser>, allowed: &[&str], op: &str) -> Result<AuthUser, AppError> {
    if let Err(e) = rbac::check_role(actor, allowed, "core", op) {
        audit::record(pool, actor.map(|u| (u.id.as_str(), u.role.as_str())), "core", op, "RBAC_GUARD", None, "DENIED", None,
            json!({"reason": e.code, "allowedRoles": allowed})).await;
        return Err(e);
    }
    Ok(actor.unwrap().clone())
}

fn valid_email(e: &str) -> bool {
    let Some((l, d)) = e.split_once('@') else { return false };
    !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !e.contains(char::is_whitespace) && e.len() <= 180
}

/// Inserts a user without creating a session (TS created then revoked one; same observable result).
async fn insert_user(pool: &PgPool, cfg: &Config, v: &Value, audit_action: &str, actor: Option<&AuthUser>, ip: &str) -> Result<AuthUser, AppError> {
    let g = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let email = g("email").to_lowercase();
    let pw = v.get("password").and_then(Value::as_str).unwrap_or("").to_string();
    let name = g("fullName"); let role = g("role");
    let lang = if g("preferredUiLang").is_empty() { "fr".into() } else { g("preferredUiLang") };
    let cc = if g("countryCode").is_empty() { "BJ".into() } else { g("countryCode").to_uppercase() };
    let mut issues = vec![];
    if !valid_email(&email) { issues.push("Invalid email"); }
    if pw.chars().count() < 8 || pw.chars().count() > 128 { issues.push("Password must be 8-128 characters"); }
    if name.chars().count() < 2 || name.chars().count() > 120 { issues.push("Full name must be 2-120 characters"); }
    if !rbac::ALL_ROLES.contains(&role.as_str()) { issues.push("Invalid role"); }
    if lang != "fr" && lang != "en" { issues.push("Invalid language"); }
    if cc.len() < 2 || cc.len() > 4 { issues.push("Invalid country code"); }
    if !issues.is_empty() { return Err(AppError::new(400, "VALIDATION_ERROR", &format!("Invalid user provisioning input: {}", issues.join(", ")))); }
    if cfg.production && auth::is_synthetic_email(&email) {
        return Err(AppError::new(403, "SYNTHETIC_ACCOUNT_FORBIDDEN_IN_PROD", "Synthetic domain accounts are strictly forbidden in production."));
    }
    let id = crypto::create_id("usr");
    let pillar = rbac::pillar_for_role(&role);
    let r = sqlx::query("INSERT INTO users (id, email, password_hash, full_name, role, pillar, preferred_ui_lang, country_code, voice_data_consent, linguistic_data_consent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(&id).bind(&email).bind(crypto::hash_password(&pw)).bind(&name).bind(&role).bind(pillar).bind(&lang).bind(&cc)
        .bind(v.get("voiceDataConsent").and_then(Value::as_bool).unwrap_or(false))
        .bind(v.get("linguisticDataConsent").and_then(Value::as_bool).unwrap_or(false)).execute(pool).await;
    if let Err(sqlx::Error::Database(d)) = &r { if d.is_unique_violation() { return Err(AppError::new(409, "EMAIL_ALREADY_EXISTS", "An account with this email already exists.")); } }
    r?;
    audit::record(pool, actor.map(|a| (a.id.as_str(), a.role.as_str())), pillar, audit_action, "user", Some(&id), "SUCCESS", Some(ip), json!({"email": email, "role": role})).await;
    Ok(AuthUser { id, email, full_name: name, role, pillar: pillar.into(), preferred_ui_lang: lang, country_code: cc, is_active: true })
}

pub async fn provision_user(pool: &PgPool, cfg: &Config, actor: Option<&AuthUser>, v: &Value, ip: &str) -> Result<AuthUser, AppError> {
    let role = v.get("role").and_then(Value::as_str).unwrap_or("");
    if role == "admin" || role == "operator" { enforce(pool, actor, &["admin"], "PROVISION_PRIVILEGED_USER").await?; }
    else { enforce(pool, actor, rbac::OPERATOR_ROLES, "PROVISION_VERIFIED_USER").await?; }
    insert_user(pool, cfg, v, "ADMIN_USER_PROVISIONED", actor, ip).await
}

pub async fn update_privacy(pool: &PgPool, user: &AuthUser, v: &Value) -> Result<Value, AppError> {
    let days = v.get("privacyRetentionDays").and_then(Value::as_i64);
    let r = days.unwrap_or(365);
    if !(30..=3650).contains(&r) { return Err(AppError::new(400, "INVALID_RETENTION", "Retention days must be between 30 and 3650.")); }
    let b = |k: &str| v.get(k).and_then(Value::as_bool);
    sqlx::query("UPDATE users SET privacy_retention_days = COALESCE($2, privacy_retention_days), marketing_consent = COALESCE($3, marketing_consent),
        voice_data_consent = COALESCE($4, voice_data_consent), linguistic_data_consent = COALESCE($5, linguistic_data_consent), updated_at = NOW() WHERE id = $1")
        .bind(&user.id).bind(days.map(|d| d as i32)).bind(b("marketingConsent")).bind(b("voiceDataConsent")).bind(b("linguisticDataConsent"))
        .execute(pool).await?;
    let input = json!({"privacyRetentionDays": days, "marketingConsent": b("marketingConsent"), "voiceDataConsent": b("voiceDataConsent"), "linguisticDataConsent": b("linguisticDataConsent")});
    let req = crypto::create_id("prv");
    sqlx::query("INSERT INTO privacy_requests (id, user_id, request_type, status, payload_json) VALUES ($1,$2,'CONSENT_UPDATE','COMPLETED',$3)")
        .bind(&req).bind(&user.id).bind(&input).execute(pool).await?;
    audit::record(pool, Some((&user.id, &user.role)), "core", "PRIVACY_CONSENT_UPDATED", "user", Some(&user.id), "SUCCESS", None, input).await;
    Ok(json!({"updated": true, "requestId": req}))
}

pub async fn export_data(pool: &PgPool, user: &AuthUser) -> Result<Value, AppError> {
    let one = |sql: &'static str| async move {
        sqlx::query_scalar::<_, Value>(&format!("SELECT COALESCE((SELECT row_to_json(t) FROM ({sql}) t LIMIT 1), 'null'::json)")).bind(&user.id).fetch_one(pool).await
    };
    let account = one("SELECT id, email, full_name, role, pillar, preferred_ui_lang, country_code, privacy_retention_days, marketing_consent, voice_data_consent, linguistic_data_consent, created_at FROM users WHERE id = $1").await?;
    let academic = one("SELECT * FROM academic_profiles WHERE user_id = $1").await?;
    let talent = one("SELECT * FROM talent_profiles WHERE user_id = $1").await?;
    let activities = rows(pool, "SELECT * FROM school_learning_activities WHERE user_id = $1 ORDER BY created_at DESC", Some(&user.id)).await?;
    let comps = rows(pool, "SELECT * FROM compensation_records WHERE contributor_user_id = $1", Some(&user.id)).await?;
    let id = crypto::create_id("prv");
    let at = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO privacy_requests (id, user_id, request_type, status, payload_json) VALUES ($1,$2,'DATA_EXPORT','COMPLETED',$3)")
        .bind(&id).bind(&user.id).bind(json!({"exportedAt": at})).execute(pool).await?;
    audit::record(pool, Some((&user.id, &user.role)), "core", "USER_DATA_EXPORTED", "privacy_request", Some(&id), "SUCCESS", None, json!({})).await;
    Ok(json!({"exportId": id, "exportedAt": at, "account": account,
        "school": {"academicProfile": academic, "activitiesCount": activities.as_array().map(|a| a.len()).unwrap_or(0), "activities": activities},
        "business": {"talentProfile": talent, "compensations": comps}}))
}

const SYNTHETIC: &[(&str, &str, &str, bool)] = &[
    ("student", "student.amina@synthetic.solob.local", "[SYNTHETIC] Amina Dossou (Terminale D — Cotonou)", false),
    ("teacher", "teacher.mensah@synthetic.solob.local", "[SYNTHETIC] Prof. Coovi Mensah (Enseignant SVT & PCT)", false),
    ("org_client", "client.waxangari@synthetic.solob.local", "[SYNTHETIC] Waxangari Health AI Lab (Client Organization)", false),
    ("contributor", "talent.fifame@synthetic.solob.local", "[SYNTHETIC] Fifamè Hounkpatin (Linguiste Fɔngbè & Français)", true),
    ("contributor", "talent.adebayo@synthetic.solob.local", "[SYNTHETIC] Adebayo Ogunleye (Spécialiste Yorùbá & NLP)", true),
    ("reviewer", "reviewer.kossi@synthetic.solob.local", "[SYNTHETIC] Kossi Agbodjan (Relecteur certifié)", false),
    ("operator", "operator.solob@synthetic.solob.local", "[SYNTHETIC] SOLOB Operations Desk", false),
    ("admin", "admin@synthetic.solob.local", "[SYNTHETIC] SOLOB Platform Admin", false),
];

/// Synthetic dev/test seed. Forbidden in production (403 + audit). Idempotent. Core accounts and flags are written here;
/// pillar sample data is created through the real School/Business services (best effort, results reported).
pub async fn seed_synthetic(s: &AppState, actor: Option<&AuthUser>) -> Result<Value, AppError> {
    let pool = &s.pool;
    if s.cfg.production {
        audit::record(pool, actor.map(|a| (a.id.as_str(), a.role.as_str())), "core", "SYNTHETIC_SEED_BLOCKED_IN_PRODUCTION", "system", None, "DENIED", None, json!({})).await;
        return Err(AppError::new(403, "SEED_FORBIDDEN_IN_PRODUCTION", "Synthetic account seeding is strictly disabled in production."));
    }
    let a = enforce(pool, actor, &["admin"], "SEED_SYNTHETIC").await?;
    ensure_flags(pool).await?;
    let accounts: Vec<Value> = SYNTHETIC.iter().map(|(r, e, _, _)| json!({"role": r, "email": e, "passwordHint": SYNTHETIC_PASSWORD})).collect();
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)").bind(SYNTHETIC[0].1).fetch_one(pool).await?;
    if exists { return Ok(json!({"seeded": true, "alreadySeeded": true, "syntheticAccounts": accounts})); }
    let mut made = std::collections::HashMap::new();
    for (role, email, name, consent) in SYNTHETIC {
        let u = insert_user(pool, &s.cfg, &json!({"email": email, "password": SYNTHETIC_PASSWORD, "fullName": name, "role": role,
            "voiceDataConsent": consent, "linguisticDataConsent": consent}), "SYNTHETIC_USER_SEEDED", Some(&a), "internal-seed").await?;
        made.insert(*email, u);
    }
    let mut pillar = vec![];
    let call = |base: String, u: AuthUser, path: &'static str, body: Value| async move {
        let r = s.http.post(format!("{}/{path}", base.trim_end_matches('/')))
            .header("x-solob-service-secret", &s.cfg.service_secret).header("x-solob-user-id", &u.id)
            .header("x-solob-user-role", &u.role).header("x-solob-user-email", &u.email)
            .timeout(std::time::Duration::from_secs(10)).json(&body).send().await;
        match r { Ok(r) => r.status().as_u16(), Err(_) => 502 }
    };
    let st = call(s.cfg.school_url.clone(), made["student.amina@synthetic.solob.local"].clone(), "profile",
        json!({"country": "BJ", "curriculumId": "cur_bj_bac", "levelId": "lvl_bj_tle_cd", "primarySubjectId": "sub_bj_svt", "learningGoals": "[SYNTHETIC] Réussir le BAC D"})).await;
    pillar.push(json!({"item": "school.academic_profile(student.amina)", "status": st}));
    let st = call(s.cfg.business_url.clone(), made["client.waxangari@synthetic.solob.local"].clone(), "actions",
        json!({"action": "create_project", "organizationName": "[SYNTHETIC] Waxangari Health AI Lab", "title": "[SYNTHETIC] Corpus vocal Fɔngbè santé",
            "description": "[SYNTHETIC] Transcription de 50 courts messages de santé publique en Fɔngbè (données fictives).", "serviceMode": "MANAGED_PROJECT", "serviceCategory": "AFRICAN_LANG_TRANSCRIPTION_ANNOTATION",
            "deliverablesSpec": "[SYNTHETIC] 50 transcriptions horodatées (JSON)", "acceptanceCriteria": "[SYNTHETIC] >= 95% exactitude sur échantillon relu",
            "targetLanguages": ["fon"], "targetDialects": [], "budgetAmountCents": 25000000, "currency": "XOF"})).await;
    pillar.push(json!({"item": "business.project(client.waxangari)", "status": st}));
    let st = call(s.cfg.business_url.clone(), made["talent.fifame@synthetic.solob.local"].clone(), "actions",
        json!({"action": "upsert_talent_profile", "headline": "[SYNTHETIC] Linguiste Fɔngbè", "country": "BJ", "nativeLanguages": ["fon"],
            "otherLanguages": ["fr"], "dialects": [], "skills": ["transcription"], "availability": "AVAILABLE", "weeklyHours": 15, "consentVoiceDataset": true})).await;
    pillar.push(json!({"item": "business.talent_profile(talent.fifame)", "status": st}));
    audit::record(pool, Some((&a.id, &a.role)), "core", "SYNTHETIC_SEED_COMPLETED", "system", None, "SUCCESS", None, json!({"accounts": SYNTHETIC.len(), "pillarData": pillar})).await;
    Ok(json!({"seeded": true, "alreadySeeded": false, "syntheticAccounts": accounts, "pillarData": pillar}))
}
