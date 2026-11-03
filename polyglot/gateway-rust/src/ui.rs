//! Minimal server-rendered pages. All dynamic values are HTML-escaped.
use crate::rbac::AuthUser;

pub const CSS: &str = "body{font-family:system-ui,sans-serif;margin:0;background:#f6f7fb;color:#1c2333}header{background:#0b3d2e;color:#fff;padding:1rem 2rem;display:flex;gap:1.5rem;align-items:center}header a{color:#fff}main{max-width:960px;margin:2rem auto;padding:0 1rem}.card{background:#fff;border-radius:12px;padding:1.5rem;margin-bottom:1rem;box-shadow:0 1px 3px #0002}.err{color:#a40000}input{display:block;margin:.4rem 0 1rem;padding:.5rem;width:100%;max-width:360px}button{padding:.5rem 1rem}textarea,select{display:block;margin:.4rem 0 1rem;padding:.5rem;width:100%;max-width:640px}textarea{min-height:5rem}pre{white-space:pre-wrap}.ok{color:#0b5d2e}";

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

pub fn page(title: &str, body: &str) -> String { layout(title, body) }

fn layout(title: &str, body: &str) -> String {
    format!("<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{t}</title><link rel=\"stylesheet\" href=\"/static/app.css\"></head><body><header><strong>SOLOB+</strong><a href=\"/\">Accueil</a><a href=\"/school\">School</a><a href=\"/business\">Business</a><a href=\"/admin\">Admin</a></header><main>{body}</main></body></html>", t = esc(title))
}

pub fn home(user: Option<&AuthUser>, csrf: Option<&str>) -> String {
    let who = match (user, csrf) {
        (Some(u), Some(c)) => format!("<p>Connecté : <strong>{}</strong> ({}, pilier {})</p><form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"csrf\" value=\"{}\"><button>Se déconnecter</button></form>",
            esc(&u.full_name), esc(&u.role), esc(&u.pillar), esc(c)),
        _ => "<p><a href=\"/login\">Se connecter</a></p>".into(),
    };
    layout("SOLOB+", &format!("<div class=\"card\"><h1>SOLOB+ — One Leg on School, One Leg on Business</h1><p>SOLOB School (académique), SOLOB Business (talents et livraison de projets), SOLOB Core (identité, sécurité, audit).</p>{who}</div>"))
}

pub fn login(error: Option<&str>) -> String {
    let e = error.map(|m| format!("<p class=\"err\">{}</p>", esc(m))).unwrap_or_default();
    layout("Connexion — SOLOB+", &format!("<div class=\"card\"><h1>Connexion</h1>{e}<form method=\"post\" action=\"/login\"><label>Email<input name=\"email\" type=\"email\" required></label><label>Mot de passe<input name=\"password\" type=\"password\" required></label><button>Se connecter</button></form></div>"))
}

pub fn pillar(title: &str, user: Option<&AuthUser>, denied: Option<String>) -> String {
    let body = match (user, denied) {
        (_, Some(m)) => format!("<p class=\"err\">Accès refusé : {}</p><p><a href=\"/login\">Se connecter avec un autre compte</a></p>", esc(&m)),
        (Some(u), None) => format!("<p>Bienvenue {} ({}).</p><p>Les fonctions de ce pilier sont exposées via l'API <code>/api/…</code> ; les écrans complets sont en cours de migration.</p>", esc(&u.full_name), esc(&u.role)),
        (None, None) => String::new(),
    };
    layout(title, &format!("<div class=\"card\"><h1>{}</h1>{body}</div>", esc(title)))
}

/// Signed-in strip shown on the public homepage (escaped values, CSRF-protected logout form).
pub fn account_strip(u: &AuthUser, csrf: &str) -> String {
    format!("<span>Connecté : <strong>{}</strong> ({}, pilier {})</span><a href=\"/school\">School</a><a href=\"/business\">Business</a><a href=\"/account\">Mon compte</a><form method=\"post\" action=\"/logout\" class=\"demo-logout\"><input type=\"hidden\" name=\"csrf\" value=\"{}\"><button>Se déconnecter</button></form>",
        esc(&u.full_name), esc(&u.role), esc(&u.pillar), esc(csrf))
}
