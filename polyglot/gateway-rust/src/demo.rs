//! Public demo (no account, no JavaScript, no DB access): server-rendered pages built from the validated mockups.
//! All data is fictitious. The only form is GET-only and never writes anything.
use crate::ui::esc;
use axum::{extract::{Path, Query}, http::{header, StatusCode}, response::{IntoResponse, Response}};
use std::collections::HashMap;

pub const DEMO_CSS: &str = concat!(include_str!("demo_assets/demo.css"), ".demo-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;background:#073D27;color:#fff;padding:8px 40px;font-size:13px}.demo-bar a{color:#fff;text-decoration:underline}.demo-bar a.on{font-weight:700;text-decoration:none;border-bottom:2px solid #E0A526}.demo-bar span{opacity:.85}.demo-logout{display:inline;margin-left:auto}.demo-badge{position:fixed;bottom:10px;right:12px;background:#C2552D;color:#fff;font-size:12px;padding:5px 10px;border-radius:6px;z-index:9}.demo-hub ul{margin:10px 0 0 18px}.demo-hub li{margin:4px 0}.demo-note{margin-top:18px}.demo-try{padding-top:0}.demo-input{width:100%;margin:6px 0 10px;font:inherit;color:#14110F}@media(max-width:820px){.demo-bar{padding:8px 16px}}");
pub const HOME_CSS: &str = concat!(include_str!("demo_assets/home.css"), ".demo-bar{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;background:#073D27;color:#fff;padding:8px 40px;font-size:13px}.demo-bar a{color:#fff;text-decoration:underline}.demo-bar a.on{font-weight:700;text-decoration:none;border-bottom:2px solid #E0A526}.demo-bar span{opacity:.85}.demo-logout{display:inline;margin-left:auto}.demo-badge{position:fixed;bottom:10px;right:12px;background:#C2552D;color:#fff;font-size:12px;padding:5px 10px;border-radius:6px;z-index:9}.demo-hub ul{margin:10px 0 0 18px}.demo-hub li{margin:4px 0}.demo-note{margin-top:18px}.demo-try{padding-top:0}.demo-input{width:100%;margin:6px 0 10px;font:inherit;color:#14110F}@media(max-width:820px){.demo-bar{padding:8px 16px}}");
const HOME_BODY: &str = include_str!("demo_assets/home.html");

pub const BUSINESS: &[(&str, &str, &str)] = &[
    ("accueil", "Accueil", include_str!("demo_assets/business-accueil.html")),
    ("missions", "Missions", include_str!("demo_assets/business-missions.html")),
    ("parcours", "Parcours de vérification", include_str!("demo_assets/business-parcours.html")),
    ("entretien-ia", "Entretien IA", include_str!("demo_assets/business-entretien-ia.html")),
    ("profil", "Profil", include_str!("demo_assets/business-profil.html")),
    ("annotation", "Annotation (Core)", include_str!("demo_assets/business-annotation.html")),
    ("espace-client", "Espace client", include_str!("demo_assets/business-espace-client.html")),
    ("gains", "Gains", include_str!("demo_assets/business-gains.html")),
];
pub const SCHOOL: &[(&str, &str, &str)] = &[
    ("tableau-de-bord", "Tableau de bord", include_str!("demo_assets/school-tableau-de-bord.html")),
    ("solob-ai", "SOLOB AI", include_str!("demo_assets/school-solob-ai.html")),
    ("library", "SOLOB Library", include_str!("demo_assets/school-library.html")),
    ("mes-cours", "Mes cours", include_str!("demo_assets/school-mes-cours.html")),
    ("espace-de-travail", "Mon espace de travail", include_str!("demo_assets/school-espace-de-travail.html")),
    ("quiz-examens", "Quiz et examens", include_str!("demo_assets/school-quiz-examens.html")),
    ("atelier-verification", "Atelier de vérification", include_str!("demo_assets/school-atelier-verification.html")),
    ("videos-educatives", "Vidéos éducatives", include_str!("demo_assets/school-videos-educatives.html")),
    ("progression", "Ma progression", include_str!("demo_assets/school-progression.html")),
    ("langues", "Langues", include_str!("demo_assets/school-langues.html")),
    ("profil", "Mon profil", include_str!("demo_assets/school-profil.html")),
];

const BADGE: &str = "<div class=\"demo-badge\" role=\"note\">Démo — données fictives</div>";

fn bar(active: &str) -> String {
    let c = |k: &str| if k == active { " class=\"on\"" } else { "" };
    format!("<div class=\"demo-bar\"><strong>Démo publique</strong><span>Navigation libre, sans compte · données fictives · aucune action n'est enregistrée</span><a{} href=\"/demo\">Toutes les démos</a><a{} href=\"/demo/business/accueil\">Business</a><a{} href=\"/demo/school/tableau-de-bord\">School</a><a href=\"/\">Accueil</a><a href=\"/login\">Se connecter</a></div>", c("hub"), c("business"), c("school"))
}

fn doc(title: &str, css: &str, body: &str) -> Response {
    let h = format!("<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><link rel=\"stylesheet\" href=\"{css}\"></head><body>{body}{BADGE}</body></html>", esc(title));
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], h).into_response()
}

/// New public homepage. `account` is an optional, already-escaped strip (signed-in user + logout form).
pub fn home(account: Option<String>) -> Response {
    let strip = account.map(|a| format!("<div class=\"demo-bar\">{a}</div>")).unwrap_or_default();
    doc("SOLOB+ — L'intelligence humaine africaine au service de l'IA", "/static/home.css", &format!("{strip}{HOME_BODY}"))
}

pub async fn hub() -> Response {
    let li = |base: &str, l: &[(&str, &str, &str)]| l.iter().map(|(s, t, _)| format!("<li><a href=\"/demo/{base}/{s}\">{t}</a></li>")).collect::<String>();
    let body = format!("{}<main><h1>Démo SOLOB+ — tous les espaces, sans compte</h1><p class=\"sub\">Chez SOLOB+, tous ne forment qu'un. Parcourez librement les espaces Business, School et Core avec des données fictives.</p><div class=\"grid g3 demo-hub\"><div class=\"card\"><h2>SOLOB Business</h2><p class=\"muted\">Talents, missions remote, vérification, espace client.</p><ul>{}</ul></div><div class=\"card\"><h2>SOLOB School</h2><p class=\"muted\">Apprentissage du primaire à l'université avec SOLOB AI.</p><ul>{}</ul></div><div class=\"card\"><h2>SOLOB Core</h2><p class=\"muted\">Annotation, évaluation et données d'IA à droits établis.</p><ul><li><a href=\"/demo/business/annotation\">Annotation et évaluation</a></li></ul></div></div><div class=\"card demo-note\" id=\"action-demo\"><h2>À propos de cette démo</h2><p>Les boutons de la démo ne déclenchent aucune action : rien n'est enregistré, aucun paiement n'est possible (paiement désactivé) et aucun service payant n'est appelé. Les chiffres, noms et réponses sont des exemples. Le support des langues africaines est expérimental et non évalué.</p><p class=\"note\">Pour utiliser l'application réelle, <a href=\"/login\">connectez-vous</a>.</p></div></main>", bar("hub"), li("business", BUSINESS), li("school", SCHOOL));
    doc("Démo — SOLOB+", "/static/demo.css", &body)
}

fn not_found() -> Response { (StatusCode::NOT_FOUND, doc("Page introuvable — Démo SOLOB+", "/static/demo.css", &format!("{}<main><h1>Page introuvable</h1><p><a href=\"/demo\">Retour à la démo</a></p></main>", bar("")))).into_response() }

pub async fn business(Path(slug): Path<String>) -> Response {
    match BUSINESS.iter().find(|(s, _, _)| *s == slug) {
        Some((_, t, b)) => doc(&format!("{t} — Démo Business SOLOB+"), "/static/demo.css", &format!("{}{b}", bar("business"))),
        None => not_found(),
    }
}

pub async fn school(Path(slug): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some((_, t, b)) = SCHOOL.iter().find(|(s, _, _)| *s == slug) else { return not_found() };
    let mut extra = String::new();
    if slug == "solob-ai" {
        // GET-only demo form: echoes the (escaped) question; no model is called and nothing is stored.
        let ans = q.get("q").map(|v| v.trim()).filter(|v| !v.is_empty()).map(|v| { let v: String = v.chars().take(300).collect();
            format!("<p><b>Vous :</b> {}</p><p class=\"muted\">Mode démo : SOLOB AI n'est pas appelé et rien n'est enregistré. Connectez-vous pour poser vos questions à l'assistant.</p>", esc(&v)) }).unwrap_or_default();
        extra = format!("<main class=\"demo-try\"><div class=\"card\"><h2>Essayer (démo)</h2><form method=\"get\" action=\"/demo/school/solob-ai\"><label for=\"q\" class=\"muted\">Votre question</label><input id=\"q\" class=\"inp demo-input\" name=\"q\" maxlength=\"300\" placeholder=\"Ex. Explique-moi la deuxième loi de Newton\"><button class=\"btn\" type=\"submit\">Envoyer</button></form>{ans}</div></main>");
    }
    doc(&format!("{t} — Démo School SOLOB+"), "/static/demo.css", &format!("{}{b}{extra}", bar("school")))
}
