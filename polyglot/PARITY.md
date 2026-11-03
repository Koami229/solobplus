# Tableau de parité final — TS (`main`) → pile polyglotte (`rewrite/polyglot`)

État au 30/10/2026 (fin de la phase 4). « Fait » = porté **et** couvert par un test automatisé exécuté localement contre PostgreSQL 16.

| Fonctionnalité TS | Service polyglotte | État | Preuve / écart |
|---|---|---|---|
| Hash de mot de passe compatible Node, sessions, CSRF, en-têtes, confiance proxy | gateway-rust | Fait | tests unitaires `crypto`, `http` |
| `/api/auth` register / login / logout / me | gateway-rust | Fait | `integration_pg.rs` |
| `/api/auth` update_privacy | gateway-rust `admin.rs` | Fait | `admin_pg.rs` (rétention 30–3650 j, `privacy_requests`, audit) |
| `/api/auth` export_data | gateway-rust `admin.rs` | Fait | `admin_pg.rs` (périmètre limité à soi, audit) |
| Limitation de débit (atomique, fail-closed) | gateway-rust | Fait | `integration_pg.rs` |
| Bootstrap admin unique (verrou) + migrations idempotentes | gateway-rust | Fait | `integration_pg.rs` |
| `/api/admin` overview | gateway-rust | Fait | `integration_pg.rs`, `admin_pg.rs` |
| `/api/admin` toggle_flag (+ verrou paiements live) | gateway-rust | Fait | `admin_pg.rs` ; drapeaux insérés par `ensure_flags` (absents avant la phase 4) |
| `/api/admin` provision_user (matrice RBAC) | gateway-rust | Fait | `admin_pg.rs` |
| `/api/admin` seed_synthetic | gateway-rust | **Partiel** | 8 comptes `[SYNTHETIC]` + drapeaux + 3 éléments piliers (profil School, projet Business, profil talent) via les vrais services. La chaîne TS complète (documents, exercices, tâches, revues) n'est pas recréée. Interdit en production (403 audité). |
| `/api/school` upsert_profile + catalogue | school-python | Fait | pytest |
| `/api/school` upload_document | school-python | Fait | pytest, E2E School |
| `/api/school` explain_grounded, generate_revision_exercise | school-python | **Partiel** | seul le mode démo déterministe `MOCK_DEMO` existe ; fournisseur IA live non porté |
| `/api/school` submit_exercise (notation) | grading-cpp + school-python | Fait | ctest 10 cas, pytest, E2E |
| `/api/business` 10 actions (create_project … update_compensation) + matching | business-java | Fait | JUnit 15 tests, E2E Business 24 étapes |
| `/api/files/[fileId]` | gateway-rust → pilier propriétaire | Fait | `school_forms_pg.rs`, `business_forms_pg.rs` |
| Pages `/`, `/school`, `/business` | gateway-rust (HTML serveur) | Fait | tests de formulaires, captures `/workspace/polyglot-*.png` |
| Page `/admin` + « Mes données » (`/account`) | gateway-rust `admin_ui.rs` | Fait | `admin_pg.rs` (RBAC, CSRF, actions) |
| Interface React (interactivité côté client, i18n complète) | — | **Écart** | remplacée par du HTML serveur sans JS ; parité fonctionnelle, pas visuelle |
| `SERVICE_SECRET` ≥ 32 caractères, échec au démarrage hors dev/test | les 3 services | Fait | tests Rust, Python et Java |
| Dockerfiles + compose | 4 services | **Non exécuté** | fichiers écrits ; aucun `docker build` lancé (Docker absent de la machine de travail, ordinateur de l'utilisateur hors ligne) |
| CI GitHub Actions | `.github/workflows/ci.yml` | **Non exécuté** | YAML validé syntaxiquement ; jamais lancé sur GitHub (pas de push) |
| Paiements réels | — | Désactivé volontairement | `PAYMENT_PROVIDER=disabled` ; l'activation du drapeau live est refusée |
