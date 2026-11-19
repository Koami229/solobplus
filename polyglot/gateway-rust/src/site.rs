//! Site public SOLOB. HTML servi par la passerelle, CSS seul, aucun script.
//! Les formulaires passent par le CSRF (origine, Fetch-Metadata, double envoi),
//! une limite de débit, puis une ligne dans `public_inquiries`.
use crate::{
    app::AppState, audit, auth, config::Config, crypto, error::AppError, http as h, rate_limit,
    rbac::AuthUser,
};
use axum::{
    extract::{OriginalUri, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Form, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

pub const SITE_CSS: &str = include_str!("site.css");
pub const FONT_FRAUNCES: &[u8] = include_bytes!("../fonts/fraunces-latin.woff2");
pub const FONT_OUTFIT: &[u8] = include_bytes!("../fonts/outfit-latin.woff2");

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    EnService,
    SurDemande,
    EnPreparation,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::EnService => "En service",
            Status::SurDemande => "Sur demande",
            Status::EnPreparation => "En préparation",
        }
    }
    fn class(self) -> &'static str {
        match self {
            Status::EnService => "status ok",
            _ => "status",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FormKind {
    Quote,
    Question,
    Mandate,
    Interest,
}

struct Offer {
    code: &'static str,
    path: &'static str,
    pole: &'static str,
    eyebrow: &'static str,
    name: &'static str,
    status: Status,
    phrase: &'static str,
    obtains: &'static [&'static str],
    does: &'static [&'static str],
    languages: &'static str,
    markets: &'static str,
    form_title: &'static str,
    form_note: &'static str,
    kind: FormKind,
}

const OFFERS: &[Offer] = &[
    Offer { code: "studio", path: "/studio", pole: "studio", eyebrow: "Studio", name: "Studio", status: Status::SurDemande,
        phrase: "Des sites et des films, tenus avec le même soin qu'une maison qui dure.",
        obtains: &["Une pièce livrée : site, motion ou film.", "Un seul interlocuteur, du brief à la remise.", "Un devis écrit après lecture du besoin."],
        does: &["Écoute le lieu, le métier et la langue du client.", "Produit sans mélanger ce travail avec School.", "Garde la suite : pages, déclinaisons, nouvelles langues."],
        languages: "Français et anglais. Autre langue, si le brief la demande.",
        markets: "Le Bénin pour les restaurants. Les autres marchés, sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. L'équipe lit la demande et répond.", kind: FormKind::Quote },
    Offer { code: "restaurants", path: "/studio/restaurants", pole: "studio", eyebrow: "Studio · Restaurants", name: "Sites pour restaurants", status: Status::SurDemande,
        phrase: "Un site de restaurant au Bénin, clair le soir comme à midi.",
        obtains: &["La carte, les horaires, l'adresse et la réservation, lisibles sur un téléphone.", "Des photographies placées, pas empilées.", "Un site que la maison peut faire évoluer."],
        does: &["Visite la salle ou travaille depuis ce que le restaurateur montre.", "Écrit en français, et dans la langue de la maison si elle le demande.", "Livre un site, pas une promesse de réservations."],
        languages: "Français. Autre langue du lieu, sur demande.",
        markets: "Bénin.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Décrivez la maison, la ville et ce que le site doit permettre.", kind: FormKind::Quote },
    Offer { code: "motion", path: "/studio/motion", pole: "studio", eyebrow: "Studio · Motion", name: "Motion design", status: Status::SurDemande,
        phrase: "Du motion design pour des marques qui ont déjà une voix.",
        obtains: &["Un film court, un habillage ou une séquence de marque.", "Une direction écrite avant les images.", "Les fichiers de remise, aux formats convenus."],
        does: &["Part du signe, de la couleur et du rythme déjà existants.", "Ne publie pas le nom d'une marque sans accord.", "Travaille pour des maisons d'ici et d'ailleurs, sur devis."],
        languages: "Français et anglais.",
        markets: "Sur demande, sans exclusivité de territoire.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Décrivez la durée, l'usage et l'échéance.", kind: FormKind::Quote },
    Offer { code: "sejours", path: "/studio/airbnb", pole: "studio", eyebrow: "Studio · Séjours", name: "Vidéos pour hôtes et conciergeries", status: Status::SurDemande,
        phrase: "Des films pour les hôtes et les conciergeries, à la mesure du logement.",
        obtains: &["Un film du lieu, utile pour une annonce ou un site.", "Une lumière et un rythme qui laissent voir l'espace.", "Une remise calibrée pour le web."],
        does: &["Filme ce qui est vraiment là.", "N'utilise aucune enseigne d'une plateforme sans accord écrit.", "Travaille avec l'hôte ou la conciergerie, pas à leur place."],
        languages: "Français et anglais.",
        markets: "Bénin, puis ailleurs sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Indiquez la ville, le nombre de logements et l'usage du film.", kind: FormKind::Quote },
    Offer { code: "immobilier", path: "/studio/immobilier", pole: "studio", eyebrow: "Studio · Immobilier", name: "Films immobiliers", status: Status::SurDemande,
        phrase: "Des films immobiliers qui montrent le bien, pas un décor inventé.",
        obtains: &["Un parcours du bien, intérieur et extérieur.", "Un montage sobre, prêt pour une annonce ou une visite.", "Les plans utiles, si le client les fournit."],
        does: &["Respecte les mesures et l'état réel du bien.", "N'affiche pas le nom d'un portail immobilier comme s'il s'agissait d'un partenaire.", "Livre le film et s'arrête là, sauf nouveau devis."],
        languages: "Français et anglais.",
        markets: "Sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Décrivez le bien, la ville et le délai.", kind: FormKind::Quote },
    Offer { code: "hotels", path: "/studio/hotels", pole: "studio", eyebrow: "Studio · Hôtels", name: "Contenus pour grands hôtels", status: Status::SurDemande,
        phrase: "Des contenus pour de grands hôtels, au rythme de la maison.",
        obtains: &["Films, photographies animées ou pages, selon le brief.", "Un ton posé, sans effet de catalogue.", "Une remise que l'hôtel peut diffuser lui-même."],
        does: &["Travaille avec l'équipe de l'hôtel, sur ce qu'elle autorise à montrer.", "N'utilise le nom d'aucune enseigne hôtelière sans confirmation écrite.", "Traite chaque maison à part."],
        languages: "Français et anglais. Autre langue de l'hôtel, sur demande.",
        markets: "Sur demande. Priorité aux maisons qui veulent un travail long.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Nommez l'hôtel seulement si vous avez le droit de le faire dans ce message.", kind: FormKind::Quote },
    Offer { code: "staffing", path: "/staffing", pole: "staffing", eyebrow: "Staffing", name: "SOLOB Staffing", status: Status::SurDemande,
        phrase: "Des professionnels vérifiés, pour un temps partiel, un temps plein ou une équipe dédiée.",
        obtains: &["Des personnes dont le parcours a été relu par SOLOB.", "Un format d'engagement choisi : partiel, plein, équipe, ou rotation pour couvrir les heures.", "Un devis, pas une grille publique."],
        does: &["Recueille la candidature, puis vérifie ce qui peut l'être.", "Ne présente personne comme vérifié tant que la revue n'est pas faite.", "Sépare ce mandat de School."],
        languages: "Français, anglais, espagnol, et langues d'Afrique de l'Ouest selon les profils réellement disponibles.",
        markets: "Afrique, et mandats à distance sur demande.",
        form_title: "Décrire un besoin", form_note: "Aucun tarif horaire n'est affiché. L'équipe répond avec un devis.", kind: FormKind::Quote },
    Offer { code: "core", path: "/core", pole: "core", eyebrow: "Core", name: "SOLOB Core", status: Status::SurDemande,
        phrase: "Des données pour entraîner et évaluer des modèles, avec des droits établis.",
        obtains: &["Annotation, évaluation, collecte, transcription et traduction.", "Des langues de travail : anglais, français, espagnol, langues d'Afrique de l'Ouest.", "Des travaux avancés sur devis : RLHF, prompts et réponses de référence, rubrics, environnements, évaluation d'agents, données robotiques, benchmarks."],
        does: &["Refuse une donnée dont les droits ne sont pas établis.", "Fait relire un travail par une autre personne que son auteur.", "Ne présente pas ces travaux avancés comme un produit déjà en service."],
        languages: "Anglais, français, espagnol. Fon, yoruba, wolof, haoussa, et d'autres langues d'Afrique de l'Ouest avec des locuteurs.",
        markets: "Laboratoires et entreprises, sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Décrivez le volume, les langues et l'échéance.", kind: FormKind::Quote },
    Offer { code: "annotation", path: "/core/annotation", pole: "core", eyebrow: "Core · Annotation", name: "Annotation", status: Status::SurDemande,
        phrase: "Annoter, transcrire, traduire, puis faire relire par quelqu'un d'autre.",
        obtains: &["Des tâches bornées, avec une consigne écrite.", "Une transcription et, quand il le faut, une traduction.", "Une relecture qui n'est pas faite par l'auteur."],
        does: &["Exige une preuve de droits et, pour la voix, un consentement daté.", "Refuse l'auto-validation.", "Livre seulement ce qui a été accepté."],
        languages: "Anglais, français, espagnol, langues d'Afrique de l'Ouest.",
        markets: "Sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. L'écran de travail des comptes autorisés se trouve dans l'espace connecté, pas sur cette page.", kind: FormKind::Quote },
    Offer { code: "evaluation", path: "/core/evaluation", pole: "core", eyebrow: "Core · Évaluation", name: "Évaluation", status: Status::SurDemande,
        phrase: "Évaluer un modèle ou un agent sur un travail réel, avec une grille.",
        obtains: &["Une grille de lecture, écrite avant les notes.", "Des prompts et des réponses de référence, si le mandat le demande.", "Une lecture humaine des échecs, pas seulement un score."],
        does: &["Construit la grille avec le commanditaire.", "Peut monter un environnement ou un benchmark pour un mandat précis.", "Ne publie aucun classement de modèle tant qu'il n'a pas été produit pour ce mandat."],
        languages: "Anglais, français, espagnol, langues du mandat.",
        markets: "Sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Ces évaluations se montent pour un mandat. Elles ne sont pas un catalogue déjà en production.", kind: FormKind::Quote },
    Offer { code: "collecte", path: "/core/collecte", pole: "core", eyebrow: "Core · Collecte", name: "Collecte de données", status: Status::SurDemande,
        phrase: "Collecter du texte et de la voix, seulement quand le droit de le faire est établi.",
        obtains: &["Un protocole de collecte écrit.", "Le consentement de la personne, daté, pour la voix.", "Un corpus dont on peut dire d'où il vient."],
        does: &["N'enregistre pas une voix sans consentement.", "Écarte ce qui ressemble à une donnée personnelle hors du mandat.", "Journalise un refus quand les droits manquent."],
        languages: "Anglais, français, espagnol, langues d'Afrique de l'Ouest.",
        markets: "Sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Décrivez le type de donnée, les langues et la preuve de droits dont vous disposez.", kind: FormKind::Quote },
    Offer { code: "langues", path: "/core/langues", pole: "core", eyebrow: "Core · Langues", name: "Langues", status: Status::SurDemande,
        phrase: "L'anglais, le français, l'espagnol, et les langues d'Afrique de l'Ouest.",
        obtains: &["Des locuteurs pour la langue demandée.", "Une validation humaine quand la langue doit être tenue pour vérifiée.", "Le droit de dire qu'une langue n'est pas encore vérifiée."],
        does: &["Ne marque pas une langue comme vérifiée sans revue.", "Traite le fon, le yoruba, le wolof et le haoussa avec des locuteurs, pas avec un dictionnaire collé.", "Ajoute une autre langue seulement si le mandat et les personnes sont là."],
        languages: "Anglais, français, espagnol, fon, yoruba, wolof, haoussa, autres sur demande.",
        markets: "Afrique de l'Ouest, et diaspora sur demande.",
        form_title: "Demander un devis", form_note: "Aucun prix n'est affiché. Nommez les langues et le niveau de vérification attendu.", kind: FormKind::Quote },
    Offer { code: "school", path: "/school", pole: "school", eyebrow: "School", name: "SOLOB School", status: Status::EnService,
        phrase: "Apprendre, du primaire à l'université, avec SOLOB AI.",
        obtains: &["Un tableau de bord, des documents, des explications sourcées, des exercices et une progression.", "Un espace séparé du travail commercial.", "L'entrée avec un compte élève ou enseignant."],
        does: &["Garde School gratuit : aucun paiement, aucune formule payante.", "Répond à partir des documents déposés, et le dit quand la source manque.", "Ouvre l'espace de travail après connexion. Cette page n'en est pas une copie."],
        languages: "Français d'abord. Autres langues des cours, selon les documents déposés.",
        markets: "Élèves et enseignants.",
        form_title: "Écrire à l'équipe", form_note: "School est gratuit. Ce message n'ouvre aucun paiement.", kind: FormKind::Question },
    Offer { code: "trading", path: "/trading", pole: "trading", eyebrow: "Trading", name: "Trading", status: Status::SurDemande,
        phrase: "Une société de trading qui s'appuie sur des agents, sous supervision humaine.",
        obtains: &["Une conversation sur le mandat, avant toute mise en œuvre.", "Des agents dont le cadre est écrit.", "Aucune prise d'ordre depuis ce site."],
        does: &["Ne publie aucun rendement, aucun gain, aucune performance.", "Ne promet pas un résultat de marché.", "Garde une personne responsable du mandat."],
        languages: "Français et anglais.",
        markets: "Sur demande, dans le cadre que la loi du pays autorise.",
        form_title: "Décrire un mandat", form_note: "Aucun rendement n'est affiché. Aucun ordre n'est passé depuis ce site.", kind: FormKind::Mandate },
    Offer { code: "telegram", path: "/telegram", pole: "telegram", eyebrow: "Telegram", name: "Bot Telegram", status: Status::EnPreparation,
        phrase: "Un bot pour les communautés dont vous êtes l'administrateur.",
        obtains: &["Rien de déployé aujourd'hui : le bot est en préparation.", "Plus tard, un accueil, des annonces et une aide à la modération, dans les groupes que vous administrez.", "Aucun accès à des membres de groupes qui ne sont pas les vôtres."],
        does: &["Ne récupère pas les membres d'un groupe.", "N'écrit pas dans un groupe sans l'accord de son administrateur.", "Préviendra les personnes qui laissent une adresse, quand il y aura quelque chose à montrer."],
        languages: "Français et anglais.",
        markets: "En préparation.",
        form_title: "Être prévenu", form_note: "Le bot est en préparation. Ce message ne crée aucun accès à un groupe.", kind: FormKind::Interest },
];

const POLES: &[(&str, &str, &str, &str, Status)] = &[
    (
        "01",
        "Studio",
        "Sites, motion, films",
        "/studio",
        Status::SurDemande,
    ),
    (
        "02",
        "Staffing",
        "Professionnels vérifiés",
        "/staffing",
        Status::SurDemande,
    ),
    (
        "03",
        "Core",
        "Données pour les modèles",
        "/core",
        Status::SurDemande,
    ),
    (
        "04",
        "School",
        "Du primaire à l'université",
        "/school",
        Status::EnService,
    ),
    (
        "05",
        "Trading",
        "Agents, sans rendement publié",
        "/trading",
        Status::SurDemande,
    ),
    (
        "06",
        "Telegram",
        "Bot de communauté",
        "/telegram",
        Status::EnPreparation,
    ),
];

const NAV: &[(&str, &str, &str)] = &[
    ("/", "Maison", "maison"),
    ("/studio", "Studio", "studio"),
    ("/staffing", "Staffing", "staffing"),
    ("/core", "Core", "core"),
    ("/school", "School", "school"),
    ("/trading", "Trading", "trading"),
    ("/telegram", "Telegram", "telegram"),
    ("/contact", "Devis", "contact"),
];

const SKILLS: &[&str] = &[
    "Développement logiciel",
    "Ingénierie IA : agents, modèles de langage, agents vocaux, recherche augmentée, adaptation de modèles, mise en production",
    "Data",
    "Cloud et DevOps",
    "Cybersécurité",
    "Qualité et tests",
    "Design et produit",
    "Support et opérations",
    "Marketing, vente, rédaction, finance, ressources humaines",
];

struct Issued {
    token: String,
    set: bool,
}

#[derive(Clone, Default)]
struct Draft {
    full_name: String,
    email: String,
    organization: String,
    message: String,
    languages: String,
    skills: String,
    availability: String,
    service: String,
}

struct Inquiry {
    kind: &'static str,
    service: String,
    full_name: String,
    email: String,
    organization: String,
    availability: String,
    skills: String,
    languages: String,
    message: String,
}

fn kind_name(k: FormKind) -> &'static str {
    match k {
        FormKind::Quote => "quote",
        FormKind::Question => "question",
        FormKind::Mandate => "mandate",
        FormKind::Interest => "interest",
    }
}

fn offer_by_code(code: &str) -> Option<&'static Offer> {
    OFFERS.iter().find(|o| o.code == code)
}
fn offer_by_path(path: &str) -> Option<&'static Offer> {
    OFFERS.iter().find(|o| o.path == path)
}

fn issue_csrf(cfg: &Config, hm: &HeaderMap) -> Issued {
    let cookies = h::parse_cookies(hm);
    if let Some(tok) = h::session_token(hm) {
        if crypto::verify_session_token_format(&cfg.session_secret, &tok) {
            let derived = crypto::derive_csrf_token(&cfg.session_secret, &tok);
            let set = cookies.get(h::CSRF_COOKIE) != Some(&derived);
            return Issued {
                token: derived,
                set,
            };
        }
    }
    if let Some(c) = cookies.get(h::CSRF_COOKIE) {
        if c.len() == 64 && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Issued {
                token: c.clone(),
                set: false,
            };
        }
    }
    Issued {
        token: crypto::random_hex(32),
        set: true,
    }
}

fn check_csrf(cfg: &Config, hm: &HeaderMap, form_token: &str) -> Result<(), AppError> {
    h::enforce_csrf(&Method::POST, hm, Some(form_token))?;
    let cookies = h::parse_cookies(hm);
    let cookie = cookies
        .get(h::CSRF_COOKIE)
        .map(String::as_str)
        .unwrap_or("");
    if cookie.is_empty() || !crypto::constant_time_eq(cookie, form_token.trim()) {
        return Err(AppError::new(
            403,
            "CSRF_VALIDATION_FAILED",
            "Jeton invalide.",
        ));
    }
    if let Some(tok) = h::session_token(hm) {
        if crypto::verify_session_token_format(&cfg.session_secret, &tok)
            && !crypto::verify_csrf_token(&cfg.session_secret, &tok, form_token.trim())
        {
            return Err(AppError::new(
                403,
                "CSRF_VALIDATION_FAILED",
                "Jeton invalide.",
            ));
        }
    }
    Ok(())
}

fn field<'a>(f: &'a HashMap<String, String>, k: &str) -> &'a str {
    f.get(k).map(String::as_str).unwrap_or("").trim()
}

fn bounded(
    s: &str,
    min: usize,
    max: usize,
    empty: &'static str,
    long: &'static str,
) -> Result<String, &'static str> {
    if s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err("Le texte contient des caractères non acceptés.");
    }
    let n = s.chars().count();
    if n < min {
        return Err(empty);
    }
    if n > max {
        return Err(long);
    }
    Ok(s.to_string())
}

fn email_of(s: &str) -> Result<String, &'static str> {
    let e = s.trim().to_lowercase();
    let bad = "L'adresse e-mail n'est pas valide.";
    let Some((l, d)) = e.split_once('@') else {
        return Err(bad);
    };
    if l.is_empty()
        || !d.contains('.')
        || d.starts_with('.')
        || d.ends_with('.')
        || e.chars().any(char::is_whitespace)
        || e.len() < 6
        || e.len() > 200
    {
        return Err(bad);
    }
    Ok(e)
}

fn validate_quote(f: &HashMap<String, String>) -> Result<Inquiry, &'static str> {
    let service = field(f, "service");
    if offer_by_code(service).is_none() {
        return Err("Choisissez un service de la liste.");
    }
    Ok(Inquiry {
        kind: "quote",
        service: service.to_string(),
        full_name: bounded(
            field(f, "full_name"),
            2,
            120,
            "Indiquez votre nom.",
            "Le nom est trop long.",
        )?,
        email: email_of(field(f, "email"))?,
        organization: bounded(
            field(f, "organization"),
            0,
            160,
            "",
            "L'organisation est trop longue.",
        )?,
        availability: String::new(),
        skills: String::new(),
        languages: String::new(),
        message: bounded(
            field(f, "message"),
            10,
            4000,
            "Le message doit faire au moins dix caractères.",
            "Le message est trop long.",
        )?,
    })
}

fn validate_talent(f: &HashMap<String, String>) -> Result<Inquiry, &'static str> {
    let availability = field(f, "availability");
    if !matches!(availability, "partiel" | "plein" | "equipe" | "rotation") {
        return Err("Choisissez une disponibilité.");
    }
    Ok(Inquiry {
        kind: "talent",
        service: "staffing".into(),
        full_name: bounded(
            field(f, "full_name"),
            2,
            120,
            "Indiquez votre nom.",
            "Le nom est trop long.",
        )?,
        email: email_of(field(f, "email"))?,
        organization: bounded(
            field(f, "organization"),
            0,
            160,
            "",
            "Le lieu est trop long.",
        )?,
        availability: availability.to_string(),
        skills: bounded(
            field(f, "skills"),
            2,
            500,
            "Indiquez vos compétences.",
            "La liste de compétences est trop longue.",
        )?,
        languages: bounded(
            field(f, "languages"),
            2,
            200,
            "Indiquez vos langues.",
            "La liste de langues est trop longue.",
        )?,
        message: bounded(
            field(f, "message"),
            10,
            4000,
            "Le message doit faire au moins dix caractères.",
            "Le message est trop long.",
        )?,
    })
}

fn draft_from(f: &HashMap<String, String>) -> Draft {
    Draft {
        full_name: field(f, "full_name").to_string(),
        email: field(f, "email").to_string(),
        organization: field(f, "organization").to_string(),
        message: field(f, "message").to_string(),
        languages: field(f, "languages").to_string(),
        skills: field(f, "skills").to_string(),
        availability: field(f, "availability").to_string(),
        service: field(f, "service").to_string(),
    }
}

fn honeypot(f: &HashMap<String, String>) -> bool {
    !field(f, "website").is_empty()
}

pub fn routes() -> Router<AppState> {
    let mut r = Router::new()
        .route("/", get(home))
        .route("/contact", get(contact_get).post(contact_post))
        .route("/contact/envoye", get(contact_done))
        .route("/staffing/candidater", get(talent_get).post(talent_post))
        .route("/staffing/candidature-envoyee", get(talent_done))
        .route("/confidentialite", get(privacy))
        .route("/static/site.css", get(css))
        .route("/static/fonts/fraunces.woff2", get(font_fraunces))
        .route("/static/fonts/outfit.woff2", get(font_outfit));
    for o in OFFERS.iter().filter(|o| o.code != "school") {
        r = r.route(o.path, get(show_offer));
    }
    r
}

async fn css() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        SITE_CSS,
    )
        .into_response()
}
async fn font_fraunces() -> Response {
    font(FONT_FRAUNCES)
}
async fn font_outfit() -> Response {
    font(FONT_OUTFIT)
}
fn font(bytes: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        bytes,
    )
        .into_response()
}

fn page(status: StatusCode, cfg: &Config, body: String, issued: &Issued) -> Response {
    let mut res = (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response();
    if issued.set {
        let sec = if cfg.production { "; Secure" } else { "" };
        let v = format!(
            "solob_csrf={}; Path=/; SameSite=Lax; Max-Age=2592000{sec}",
            issued.token
        );
        if let Ok(hv) = HeaderValue::from_str(&v) {
            res.headers_mut().insert(header::SET_COOKIE, hv);
        }
    }
    res
}

async fn viewer(s: &AppState, hm: &HeaderMap) -> Result<Option<AuthUser>, AppError> {
    auth::authenticate(&s.pool, &s.cfg, h::session_token(hm).as_deref()).await
}

async fn home(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, &hm);
    let user = viewer(&s, &hm).await?;
    let body = document(
        "SOLOB",
        "maison",
        &issued.token,
        user.as_ref(),
        &home_main(),
    );
    Ok(page(StatusCode::OK, &s.cfg, body, &issued))
}

async fn show_offer(
    State(s): State<AppState>,
    hm: HeaderMap,
    OriginalUri(uri): OriginalUri,
) -> Result<Response, AppError> {
    let Some(o) = offer_by_path(uri.path()) else {
        return Ok(page(
            StatusCode::NOT_FOUND,
            &s.cfg,
            document(
                "Introuvable",
                "",
                "",
                None,
                "<p>Cette page n'existe pas.</p>",
            ),
            &Issued {
                token: String::new(),
                set: false,
            },
        ));
    };
    let issued = issue_csrf(&s.cfg, &hm);
    let user = viewer(&s, &hm).await?;
    let body = document(
        &format!("{} — SOLOB", o.name),
        o.pole,
        &issued.token,
        user.as_ref(),
        &offer_main(
            o,
            &issued.token,
            None,
            &Draft {
                service: o.code.into(),
                ..Draft::default()
            },
        ),
    );
    Ok(page(StatusCode::OK, &s.cfg, body, &issued))
}

/// Porte de School pour une personne non connectée. L'espace de travail reste `school_ui`.
pub async fn school_gate(s: &AppState, hm: &HeaderMap) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, hm);
    let user = viewer(s, hm).await?;
    let o = offer_by_code("school").expect("school offer");
    let main = offer_main(
        o,
        &issued.token,
        None,
        &Draft {
            service: "school".into(),
            ..Draft::default()
        },
    );
    let enter = "<p class=\"actions\"><a class=\"btn\" href=\"/login\">Se connecter pour entrer dans School</a></p>";
    let body = document(
        "School — SOLOB",
        "school",
        &issued.token,
        user.as_ref(),
        &format!("{main}{enter}"),
    );
    Ok(page(StatusCode::OK, &s.cfg, body, &issued))
}

#[derive(Deserialize)]
struct ServiceQuery {
    service: Option<String>,
}

async fn contact_get(
    State(s): State<AppState>,
    hm: HeaderMap,
    Query(q): Query<ServiceQuery>,
) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, &hm);
    let user = viewer(&s, &hm).await?;
    let service = q
        .service
        .filter(|c| offer_by_code(c).is_some())
        .unwrap_or_default();
    let body = document(
        "Devis — SOLOB",
        "contact",
        &issued.token,
        user.as_ref(),
        &contact_main(
            &issued.token,
            None,
            &Draft {
                service,
                ..Draft::default()
            },
        ),
    );
    Ok(page(StatusCode::OK, &s.cfg, body, &issued))
}

async fn contact_post(
    State(s): State<AppState>,
    hm: HeaderMap,
    Form(f): Form<HashMap<String, String>>,
) -> Result<Response, AppError> {
    submit_quote(&s, &hm, &f).await
}

async fn talent_get(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, &hm);
    let user = viewer(&s, &hm).await?;
    let body = document(
        "Candidature — SOLOB",
        "staffing",
        &issued.token,
        user.as_ref(),
        &talent_main(&issued.token, None, &Draft::default()),
    );
    Ok(page(StatusCode::OK, &s.cfg, body, &issued))
}

async fn talent_post(
    State(s): State<AppState>,
    hm: HeaderMap,
    Form(f): Form<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, &hm);
    if let Err(e) = check_csrf(&s.cfg, &hm, field(&f, "csrf")) {
        return Ok(refused(
            &s.cfg,
            &issued,
            e.status,
            "La candidature n'a pas été acceptée. Rechargez la page et renvoyez le formulaire.",
        ));
    }
    if honeypot(&f) {
        return Ok(Redirect::to("/staffing/candidature-envoyee").into_response());
    }
    let draft = draft_from(&f);
    let inquiry = match validate_talent(&f) {
        Ok(v) => v,
        Err(msg) => {
            let user = viewer(&s, &hm).await?;
            let body = document(
                "Candidature — SOLOB",
                "staffing",
                &issued.token,
                user.as_ref(),
                &talent_main(&issued.token, Some(msg), &draft),
            );
            return Ok(page(StatusCode::BAD_REQUEST, &s.cfg, body, &issued));
        }
    };
    if let Some(res) = limited(&s, &hm, &inquiry.email, &issued).await? {
        return Ok(res);
    }
    store(&s, &hm, &inquiry).await?;
    Ok(Redirect::to("/staffing/candidature-envoyee").into_response())
}

async fn contact_done(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    done(&s, &hm, "contact", "Demande envoyée", "La demande est enregistrée. L'équipe la lit et répond à l'adresse indiquée. Aucun paiement n'est lancé.").await
}
async fn talent_done(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    done(&s, &hm, "staffing", "Candidature envoyée", "La candidature est enregistrée. Elle sera lue. Elle ne vaut pas, à elle seule, une vérification.").await
}
async fn privacy(State(s): State<AppState>, hm: HeaderMap) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, &hm);
    let user = viewer(&s, &hm).await?;
    Ok(page(
        StatusCode::OK,
        &s.cfg,
        document(
            "Confidentialité — SOLOB",
            "",
            &issued.token,
            user.as_ref(),
            &privacy_main(),
        ),
        &issued,
    ))
}

async fn done(
    s: &AppState,
    hm: &HeaderMap,
    pole: &str,
    title: &str,
    text: &str,
) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, hm);
    let user = viewer(s, hm).await?;
    let main = format!("<article class=\"sheet done wrap\"><p class=\"status ok\">Enregistré</p><h1>{}</h1><p class=\"lede\">{}</p><p class=\"actions\"><a class=\"btn ghost\" href=\"/\">Retour à la maison</a></p></article>", crate::ui::esc(title), crate::ui::esc(text));
    Ok(page(
        StatusCode::OK,
        &s.cfg,
        document(
            &format!("{title} — SOLOB"),
            pole,
            &issued.token,
            user.as_ref(),
            &main,
        ),
        &issued,
    ))
}

async fn submit_quote(
    s: &AppState,
    hm: &HeaderMap,
    f: &HashMap<String, String>,
) -> Result<Response, AppError> {
    let issued = issue_csrf(&s.cfg, hm);
    if let Err(e) = check_csrf(&s.cfg, hm, field(f, "csrf")) {
        return Ok(refused(
            &s.cfg,
            &issued,
            e.status,
            "La demande n'a pas été acceptée. Rechargez la page et renvoyez le formulaire.",
        ));
    }
    if honeypot(f) {
        return Ok(Redirect::to("/contact/envoye").into_response());
    }
    let draft = draft_from(f);
    let inquiry = match validate_quote(f) {
        Ok(v) => v,
        Err(msg) => {
            let user = viewer(s, hm).await?;
            let path = offer_by_code(&draft.service)
                .map(|o| o.path)
                .unwrap_or("/contact");
            let main = if path == "/contact" || offer_by_code(&draft.service).is_none() {
                contact_main(&issued.token, Some(msg), &draft)
            } else {
                let o = offer_by_code(&draft.service).unwrap();
                offer_main(o, &issued.token, Some(msg), &draft)
            };
            let pole = offer_by_code(&draft.service)
                .map(|o| o.pole)
                .unwrap_or("contact");
            let body = document("Devis — SOLOB", pole, &issued.token, user.as_ref(), &main);
            return Ok(page(StatusCode::BAD_REQUEST, &s.cfg, body, &issued));
        }
    };
    if let Some(res) = limited(s, hm, &inquiry.email, &issued).await? {
        return Ok(res);
    }
    store(s, hm, &inquiry).await?;
    Ok(Redirect::to("/contact/envoye").into_response())
}

async fn limited(
    s: &AppState,
    hm: &HeaderMap,
    email: &str,
    issued: &Issued,
) -> Result<Option<Response>, AppError> {
    let ip = h::client_key(&s.cfg, hm);
    let msg = "Trop de messages viennent d'être envoyés. Réessayez plus tard.";
    for (key, max, window) in [
        (format!("site:form:{ip}"), 8, 600_000),
        (format!("site:email:{email}"), 4, 3_600_000),
    ] {
        match rate_limit::check(&s.pool, &key, max, window).await {
            Ok(d) if d.allowed => {}
            Ok(_) => return Ok(Some(refused(&s.cfg, issued, 429, msg))),
            Err(_) => return Ok(Some(refused(&s.cfg, issued, 503, "L'envoi est suspendu parce que la limite de débit ne répond pas. Réessayez plus tard."))),
        }
    }
    Ok(None)
}

async fn store(s: &AppState, hm: &HeaderMap, q: &Inquiry) -> Result<(), AppError> {
    let id = crypto::create_id("inq");
    let user = viewer(s, hm).await?;
    sqlx::query("INSERT INTO public_inquiries (id, kind, service, full_name, email, organization, availability, skills, languages, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(&id).bind(q.kind).bind(&q.service).bind(&q.full_name).bind(&q.email).bind(&q.organization)
        .bind(&q.availability).bind(&q.skills).bind(&q.languages).bind(&q.message)
        .execute(&s.pool).await.map_err(|e| { eprintln!("public inquiry insert failed: {e}"); e })?;
    let pillar = match q.service.as_str() {
        "school" => "school",
        "core" | "annotation" | "evaluation" | "collecte" | "langues" => "core",
        _ => "business",
    };
    audit::record(
        &s.pool,
        user.as_ref().map(|u| (u.id.as_str(), u.role.as_str())),
        pillar,
        "PUBLIC_INQUIRY_CREATED",
        "public_inquiry",
        Some(&id),
        "SUCCESS",
        Some(&h::client_key(&s.cfg, hm)),
        json!({"kind": q.kind, "service": q.service}),
    )
    .await;
    Ok(())
}

fn refused(cfg: &Config, issued: &Issued, status: u16, msg: &str) -> Response {
    let main = format!("<article class=\"sheet wrap\"><h1>Envoi interrompu</h1><p class=\"lede\">{}</p><p class=\"actions\"><a class=\"btn ghost\" href=\"/contact\">Revenir au formulaire</a></p></article>", crate::ui::esc(msg));
    page(
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        cfg,
        document("Envoi — SOLOB", "contact", &issued.token, None, &main),
        issued,
    )
}

fn home_main() -> String {
    let mut index = String::from("<ol class=\"index\">");
    for (n, name, meta, href, status) in POLES {
        index.push_str(&format!(
            "<li><a href=\"{href}\"><span class=\"n\">{n}</span><span class=\"name\">{name}</span><span class=\"meta\">{meta}</span><span class=\"{cls}\">{label}</span><span class=\"go\" aria-hidden=\"true\">→</span></a></li>",
            name = esc(name), meta = esc(meta), cls = status.class(), label = esc(status.label())));
    }
    index.push_str("</ol>");
    format!(
        "<section class=\"hero\"><div class=\"wrap\">\
<p class=\"brand-mark\" aria-label=\"SOLOB\">SOLOB</p>\
<p class=\"eyebrow\">Porto-Novo · Bénin</p>\
<h1>Une maison pour les langues, les talents et les données.</h1>\
<p class=\"lede\">School forme. Staffing réunit des professionnels vérifiés. Core prépare les données qui entraînent et évaluent les modèles. Studio produit les images. Chez SOLOB, tous ne forment qu'un.</p>\
<div class=\"actions\"><a class=\"btn\" href=\"/contact\">Demander un devis</a><a class=\"btn ghost\" href=\"/school\">Entrer dans School</a></div>\
</div></section>\
<section class=\"section poles\"><div class=\"wrap\">\
<p class=\"section-kicker\">Les pôles</p>\
{index}\
</div></section>\
<section class=\"section truth\"><div class=\"wrap narrow\">\
<h2>Ce qui est vrai.</h2>\
<p class=\"lede\">Chaque pôle a sa page, son statut, et un formulaire qui enregistre vraiment la demande.</p>\
<p>School est gratuit. Il n'y a pas de paiement.</p>\
<p>Studio, Staffing, Core et Trading se traitent sur devis. Aucun prix n'est publié.</p>\
<p>Les langues d'Afrique de l'Ouest sont une spécialité de travail, pas un ornement. Une langue non vérifiée n'est pas présentée comme vérifiée.</p>\
<p>Le bot Telegram est en préparation. Il ne sert pas à récupérer des membres de groupes.</p>\
</div></section>"
    )
}

fn offer_main(o: &Offer, csrf: &str, err: Option<&str>, draft: &Draft) -> String {
    let links = children(o);
    let skills = if o.code == "staffing" {
        let items: String = SKILLS
            .iter()
            .map(|s| format!("<li>{}</li>", esc(s)))
            .collect();
        format!("<section class=\"reveal skills-block\"><h2>Compétences</h2><ul class=\"skills\">{items}</ul></section>")
    } else {
        String::new()
    };
    let candid = if o.code == "staffing" {
        "<p class=\"actions reveal\"><a class=\"btn ghost\" href=\"/staffing/candidater\">Proposer sa candidature</a></p>"
    } else {
        ""
    };
    format!(
        "<article class=\"sheet\"><div class=\"wrap\">\
<p class=\"{cls}\">{label}</p><p class=\"eyebrow\">{eye}</p><h1>{phrase}</h1>\
<div class=\"split\"><section class=\"reveal\"><h2>Ce que vous obtenez</h2><ul>{obtains}</ul></section>\
<section class=\"reveal\"><h2>Ce que SOLOB fait</h2><ul>{does}</ul></section></div>\
{skills}{links}{candid}\
<dl class=\"facts\"><div><dt>Langues</dt><dd>{langs}</dd></div><div><dt>Marchés</dt><dd>{markets}</dd></div></dl>\
{form}</div></article>",
        cls = o.status.class(), label = esc(o.status.label()), eye = esc(o.eyebrow), phrase = esc(o.phrase),
        obtains = items(o.obtains), does = items(o.does),
        langs = esc(o.languages), markets = esc(o.markets),
        form = quote_form(o, csrf, err, draft)
    )
}

fn children(o: &Offer) -> String {
    let prefix = format!("{}/", o.path.trim_end_matches('/'));
    let kids: Vec<_> = OFFERS
        .iter()
        .filter(|c| c.path.starts_with(&prefix))
        .collect();
    if kids.is_empty() {
        return String::new();
    }
    let mut html = String::from("<ul class=\"links\">");
    for c in kids {
        html.push_str(&format!("<li><a href=\"{}\"><span>{}</span><span class=\"go\" aria-hidden=\"true\">→</span></a></li>", c.path, esc(c.name)));
    }
    html.push_str("</ul>");
    html
}

fn items(list: &[&str]) -> String {
    list.iter()
        .map(|i| format!("<li>{}</li>", esc(i)))
        .collect()
}

fn quote_form(o: &Offer, csrf: &str, err: Option<&str>, draft: &Draft) -> String {
    let err = err
        .map(|m| format!("<p class=\"err\" role=\"alert\">{}</p>", esc(m)))
        .unwrap_or_default();
    format!(
        "<form class=\"form form-{}\" method=\"post\" action=\"/contact\"><h2>{}</h2><p class=\"note\">{}</p>{err}\
<input type=\"hidden\" name=\"csrf\" value=\"{}\"><input type=\"hidden\" name=\"service\" value=\"{}\">\
<p class=\"service-line\">Service · <strong>{}</strong></p>\
<div class=\"hp\" aria-hidden=\"true\"><label>Site<input name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></label></div>\
<div class=\"row\"><div><label>Nom<input name=\"full_name\" required maxlength=\"120\" value=\"{}\" autocomplete=\"name\"></label></div>\
<div><label>E-mail<input name=\"email\" type=\"email\" required maxlength=\"200\" value=\"{}\" autocomplete=\"email\"></label></div></div>\
<label>Organisation<input name=\"organization\" maxlength=\"160\" value=\"{}\" autocomplete=\"organization\"></label>\
<label>Message<textarea name=\"message\" required minlength=\"10\" maxlength=\"4000\">{}</textarea></label>\
<button class=\"btn\" type=\"submit\">Envoyer</button>\
<p class=\"note\">Le message est conservé pour la réponse. <a href=\"/confidentialite\">Confidentialité</a>.</p></form>",
        kind_name(o.kind), esc(o.form_title), esc(o.form_note), esc(csrf), esc(o.code), esc(o.name),
        esc(&draft.full_name), esc(&draft.email), esc(&draft.organization), esc(&draft.message))
}

fn contact_main(csrf: &str, err: Option<&str>, draft: &Draft) -> String {
    let err = err
        .map(|m| format!("<p class=\"err\" role=\"alert\">{}</p>", esc(m)))
        .unwrap_or_default();
    let mut options = String::from("<option value=\"\">Choisir</option>");
    for o in OFFERS {
        let sel = if draft.service == o.code {
            " selected"
        } else {
            ""
        };
        options.push_str(&format!(
            "<option value=\"{}\"{sel}>{}</option>",
            esc(o.code),
            esc(o.name)
        ));
    }
    format!(
        "<article class=\"sheet\"><div class=\"wrap\"><p class=\"status\">Sur demande</p>\
<h1>Décrire le besoin.</h1><p class=\"lede\">Le formulaire enregistre la demande. Il n'affiche aucun prix et ne lance aucun paiement. School reste gratuit.</p>\
<form class=\"form\" method=\"post\" action=\"/contact\"><h2>Demande</h2>{err}\
<input type=\"hidden\" name=\"csrf\" value=\"{}\">\
<div class=\"hp\" aria-hidden=\"true\"><label>Site<input name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></label></div>\
<label>Service<select name=\"service\" required>{options}</select></label>\
<div class=\"row\"><div><label>Nom<input name=\"full_name\" required maxlength=\"120\" value=\"{}\" autocomplete=\"name\"></label></div>\
<div><label>E-mail<input name=\"email\" type=\"email\" required maxlength=\"200\" value=\"{}\" autocomplete=\"email\"></label></div></div>\
<label>Organisation<input name=\"organization\" maxlength=\"160\" value=\"{}\" autocomplete=\"organization\"></label>\
<label>Message<textarea name=\"message\" required minlength=\"10\" maxlength=\"4000\">{}</textarea></label>\
<button class=\"btn\" type=\"submit\">Envoyer</button>\
<p class=\"note\"><a href=\"/confidentialite\">Confidentialité</a>.</p></form></div></article>",
        esc(csrf), esc(&draft.full_name), esc(&draft.email), esc(&draft.organization), esc(&draft.message))
}

fn talent_main(csrf: &str, err: Option<&str>, draft: &Draft) -> String {
    let err = err
        .map(|m| format!("<p class=\"err\" role=\"alert\">{}</p>", esc(m)))
        .unwrap_or_default();
    let opts = [
        ("partiel", "Temps partiel"),
        ("plein", "Temps plein"),
        ("equipe", "Équipe dédiée"),
        ("rotation", "Rotation"),
    ];
    let mut options = String::from("<option value=\"\">Choisir</option>");
    for (v, label) in opts {
        let sel = if draft.availability == v {
            " selected"
        } else {
            ""
        };
        options.push_str(&format!(
            "<option value=\"{v}\"{sel}>{}</option>",
            esc(label)
        ));
    }
    format!(
        "<article class=\"sheet\"><div class=\"wrap\"><p class=\"status\">Sur demande</p><p class=\"eyebrow\">Staffing</p>\
<h1>Proposer sa candidature.</h1><p class=\"lede\">La candidature est enregistrée. Elle ne signifie pas encore que le profil est vérifié.</p>\
<form class=\"form\" method=\"post\" action=\"/staffing/candidater\"><h2>Candidature</h2>{err}\
<input type=\"hidden\" name=\"csrf\" value=\"{}\">\
<div class=\"hp\" aria-hidden=\"true\"><label>Site<input name=\"website\" tabindex=\"-1\" autocomplete=\"off\"></label></div>\
<div class=\"row\"><div><label>Nom<input name=\"full_name\" required maxlength=\"120\" value=\"{}\" autocomplete=\"name\"></label></div>\
<div><label>E-mail<input name=\"email\" type=\"email\" required maxlength=\"200\" value=\"{}\" autocomplete=\"email\"></label></div></div>\
<label>Ville ou pays<input name=\"organization\" maxlength=\"160\" value=\"{}\"></label>\
<label>Langues<input name=\"languages\" required maxlength=\"200\" value=\"{}\"></label>\
<label>Compétences<input name=\"skills\" required maxlength=\"500\" value=\"{}\"></label>\
<label>Disponibilité<select name=\"availability\" required>{options}</select></label>\
<label>Message<textarea name=\"message\" required minlength=\"10\" maxlength=\"4000\">{}</textarea></label>\
<button class=\"btn\" type=\"submit\">Envoyer la candidature</button>\
<p class=\"note\"><a href=\"/confidentialite\">Confidentialité</a>.</p></form></div></article>",
        esc(csrf), esc(&draft.full_name), esc(&draft.email), esc(&draft.organization), esc(&draft.languages), esc(&draft.skills), esc(&draft.message))
}

fn privacy_main() -> &'static str {
    "<article class=\"sheet\"><div class=\"wrap narrow\"><p class=\"eyebrow\">Confidentialité</p>\
<h1>Ce que SOLOB garde, et pourquoi.</h1>\
<p class=\"lede\">SOLOB est à Porto-Novo, au Bénin. Le dossier auprès de l'APDP est en cours. Cette page décrit le site public. Elle ne remplace pas ce dossier.</p>\
<h2>Demandes et candidatures</h2>\
<p>Le nom, l'adresse, l'organisation, le message et le service choisi sont enregistrés pour répondre. Ils ne sont pas vendus. Une personne peut demander l'accès, la rectification ou l'effacement en écrivant via le formulaire de contact.</p>\
<h2>Comptes</h2>\
<p>School, Business et les espaces connectés ont leurs propres comptes. School est gratuit. Aucun paiement n'est pris sur ce site.</p>\
<h2>Voix et données pour les modèles</h2>\
<p>Une collecte de voix ou de texte pour entraîner un modèle ne se fait pas depuis ce formulaire. Elle exige des droits établis et, pour la voix, un consentement daté.</p>\
</div></article>"
}

fn document(title: &str, pole: &str, csrf: &str, user: Option<&AuthUser>, main: &str) -> String {
    let mut nav = String::from("<ul class=\"nav-links\">");
    for (href, label, key) in NAV {
        let cur = if *key == pole {
            " aria-current=\"page\""
        } else {
            ""
        };
        nav.push_str(&format!(
            "<li><a href=\"{href}\"{cur}>{}</a></li>",
            esc(label)
        ));
    }
    nav.push_str("</ul>");
    let account = match user {
        Some(u) => format!("<div class=\"account\"><span>{}</span><form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"csrf\" value=\"{}\"><button type=\"submit\">Se déconnecter</button></form></div>", esc(&u.full_name), esc(csrf)),
        None => "<div class=\"account\"><a href=\"/login\">Connexion</a></div>".into(),
    };
    format!(
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"theme-color\" content=\"#090a0c\">\
<meta name=\"description\" content=\"SOLOB — School, Staffing, Core, Studio. Une maison pour les langues, les talents et les données. Porto-Novo.\">\
<title>{}</title><link rel=\"stylesheet\" href=\"/static/site.css\"></head><body>\
<a class=\"skip\" href=\"#contenu\">Aller au contenu</a>\
<header class=\"nav\"><a class=\"brand\" href=\"/\">SOLOB</a>{nav}{account}</header>\
<main id=\"contenu\">{main}</main>\
<footer class=\"foot wrap\"><div><p class=\"brand-foot\">SOLOB</p><p class=\"motto\">Chez SOLOB, tous ne forment qu'un.</p></div>\
<nav><a href=\"/confidentialite\">Confidentialité</a><a href=\"/school\">School</a><a href=\"/business\">Espace Business</a><a href=\"/login\">Connexion</a></nav></footer>\
</body></html>",
        esc(title)
    )
}

fn esc(s: &str) -> String {
    crate::ui::esc(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_holds_the_nuit_tokens_and_motion() {
        assert!(SITE_CSS.contains("--encre: #090a0c"));
        assert!(SITE_CSS.contains("--encre-2: #12141a"));
        assert!(SITE_CSS.contains("--ivoire: #f3efe6"));
        assert!(SITE_CSS.contains("--pierre: #8e8a82"));
        assert!(SITE_CSS.contains("--ok: #b7d4c2"));
        assert!(SITE_CSS.contains("animation-timeline: view()"));
        assert!(SITE_CSS.contains("cubic-bezier(0.2, 0.7, 0.2, 1)"));
        assert!(SITE_CSS.contains("prefers-reduced-motion"));
        assert!(SITE_CSS.contains("outline: 2px solid var(--ivoire)"));
        assert!(!SITE_CSS.contains("box-shadow"));
        assert!(!FONT_FRAUNCES.is_empty() && !FONT_OUTFIT.is_empty());
    }

    #[test]
    fn home_is_server_html_without_script_or_invented_proof() {
        let html = document("SOLOB", "maison", "abc", None, &home_main());
        let low = html.to_lowercase();
        assert!(!low.contains("<script"));
        assert!(!html.contains("onclick"));
        assert!(html.contains("class=\"brand-mark\""));
        assert!(html.contains("Une maison pour les langues, les talents et les données."));
        assert!(html.contains("Chez SOLOB, tous ne forment qu'un."));
        assert!(html.contains("Ce qui est vrai."));
        assert!(!html.contains("class=\"grid\""));
        for n in ["01", "02", "03", "04", "05", "06"] {
            assert!(html.contains(n), "{n}");
        }
        assert!(html.contains("En service"));
        assert!(html.contains("Sur demande"));
        assert!(html.contains("En préparation"));
        for banned in ["Sofitel", "Zillow", "Airbnb", "FCFA", "€", "$"] {
            assert!(!html.contains(banned), "{banned}");
        }
    }

    #[test]
    fn every_offer_has_the_same_skeleton() {
        for o in OFFERS {
            let html = offer_main(
                o,
                "tok",
                None,
                &Draft {
                    service: o.code.into(),
                    ..Draft::default()
                },
            );
            assert!(html.contains(&esc(o.phrase)), "{}", o.code);
            assert!(html.contains("Ce que vous obtenez"), "{}", o.code);
            assert!(html.contains("Ce que SOLOB fait"), "{}", o.code);
            assert!(html.contains(o.status.label()), "{}", o.code);
            assert!(html.contains("name=\"service\""), "{}", o.code);
            assert!(!html.to_lowercase().contains("<script"), "{}", o.code);
            assert!(
                !html.contains("Sofitel") && !html.contains("Zillow"),
                "{}",
                o.code
            );
        }
        let trading = offer_main(
            offer_by_code("trading").unwrap(),
            "t",
            None,
            &Draft::default(),
        );
        assert!(trading.contains("Aucun rendement"));
        assert!(!trading.contains('%'));
        let telegram = offer_main(
            offer_by_code("telegram").unwrap(),
            "t",
            None,
            &Draft::default(),
        );
        assert!(telegram.contains("En préparation"));
        assert!(telegram.contains("Ne récupère pas les membres"));
        let school = offer_main(
            offer_by_code("school").unwrap(),
            "t",
            None,
            &Draft::default(),
        );
        assert!(school.contains("gratuit"));
        assert!(school.contains("En service"));
    }

    #[test]
    fn quote_and_talent_validation() {
        let mut ok = HashMap::from([
            ("service".into(), "restaurants".into()),
            ("full_name".into(), "Ama K".into()),
            ("email".into(), "Ama@Example.org".into()),
            ("organization".into(), "Maison".into()),
            (
                "message".into(),
                "Nous voulons un site pour la salle.".into(),
            ),
        ]);
        let q = validate_quote(&ok).unwrap();
        assert_eq!(q.email, "ama@example.org");
        assert_eq!(q.service, "restaurants");
        ok.insert("service".into(), "unknown".into());
        assert!(validate_quote(&ok).is_err());
        ok.insert("service".into(), "restaurants".into());
        ok.insert("message".into(), "court".into());
        assert!(validate_quote(&ok).is_err());
        let mut talent = HashMap::from([
            ("full_name".into(), "Kofi M".into()),
            ("email".into(), "kofi@example.org".into()),
            ("organization".into(), "Cotonou".into()),
            ("languages".into(), "français, fon".into()),
            ("skills".into(), "Rust, Python".into()),
            ("availability".into(), "plein".into()),
            ("message".into(), "Je cherche une équipe dédiée.".into()),
        ]);
        assert_eq!(validate_talent(&talent).unwrap().kind, "talent");
        talent.insert("availability".into(), "nuit".into());
        assert!(validate_talent(&talent).is_err());
        talent.insert("availability".into(), "plein".into());
        talent.insert("website".into(), "https://spam.example".into());
        assert!(honeypot(&talent));
    }
}
