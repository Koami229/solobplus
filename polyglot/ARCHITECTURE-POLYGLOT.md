# SOLOB+ — Architecture polyglotte (Rust · Python · Java · C++)

Branche `rewrite/polyglot` (issue de `mcdl/critical-hardening`). L'app TypeScript de `main` reste intacte ;
les migrations SQL `db/migrations/001..003` sont réutilisées telles quelles (embarquées par la passerelle Rust).

## 1. Vue d'ensemble (MCDL — couches p.54, MVC p.55-56)

```
Navigateur (HTML rendu serveur, 0 JS, CSP sans 'unsafe-inline')
      │  cookies solob_session (HttpOnly) + solob_csrf
      ▼
[Présentation + contrôle d'accès]  gateway-rust (Axum)      :8100  ── seul service exposé
      │  HTTP interne + x-solob-service-secret + x-solob-user-{id,role,email}
      ├──▶ [Métier School]   school-python (FastAPI)        :8101
      ├──▶ [Métier Business] business-java (Java 21)         :8102
      │         └─ (prévu) bibliothèque/CLI grading-cpp (C++20) pour la notation
      ▼
[Accès données] sqlx / psycopg / JDBC   ──▶ [Base] PostgreSQL 16 (schéma unique, migrations 001-003)
```

Règle des couches (p.54) : le navigateur ne parle qu'à la passerelle ; les services métier ne sont joignables
que par la passerelle (secret de service, comparaison à temps constant, refus si secret < 32 car.) ; seuls les
modules d'accès aux données touchent PostgreSQL. MVC (p.55-56) : `ui.rs` = View, `app.rs` = Controller,
services métier + SQL = Model.

Cohésion / couplage (p.53) : un service par pilier (cohésion forte : tout le School dans un seul module) ;
couplage limité à un **contrat HTTP JSON** unique et à l'en-tête d'identité. La sécurité transverse (auth,
CSRF, RBAC grossier, rate limit, en-têtes) est centralisée dans un seul module (Rust) au lieu d'être
dupliquée trois fois. Couplage résiduel assumé : schéma PostgreSQL partagé (voir risques).

## 2. Correspondance fonctionnalités TS → service cible

| TS (source) | Cible | Statut |
|---|---|---|
| `src/lib/core/{auth,session,csrf,crypto,rate-limit,headers,proxy}` | gateway-rust `auth.rs http.rs crypto.rs rate_limit.rs` | **Fait** (testé PG) |
| `POST/GET /api/auth` register, login, logout, me | gateway-rust | **Fait** |
| `/api/auth` update_privacy, export_data | gateway-rust | À faire (renvoie UNKNOWN_ACTION) |
| bootstrap admin (verrou consultatif) | gateway-rust `bootstrap-admin` | **Fait** (concurrence testée) |
| migrations `schema_migrations` | gateway-rust `migrate` | **Fait** (idempotence testée) |
| `/api/admin` overview | gateway-rust | Partiel (overview lecture seule) |
| `/api/admin` seed_synthetic, provision_user, toggle_flag | gateway-rust | À faire |
| `/api/school` upsert_profile + catalogue | school-python `/profile` `/catalog` | **Fait** |
| `/api/school` upload_document, explain_grounded, generate_revision_exercise | school-python | À faire |
| `/api/school` submit_exercise (notation) | grading-cpp (algorithme) + school-python (orchestration) | Partiel : algo porté et testé en C++, pas encore branché |
| `/api/business` create_project | business-java `POST /projects` | **Fait** |
| `/api/business` review_project, upsert_talent_profile, record_assessment, matching, create_assign_task, submit_work, review_submission, finalize_delivery, update_compensation | business-java | À faire |
| `/api/files/[fileId]` | gateway-rust (contrôle d'accès) + stockage | À faire |
| pages `/`, `/school`, `/business`, `/admin` (React) | gateway-rust `ui.rs` (HTML serveur) | Partiel : squelettes + login/logout ; formulaires métier à faire |

## 3. Contrat d'API

- Externe (inchangé pour les clients) : `POST /api/auth {action,...}`, `GET /api/auth`, `GET /api/health`,
  `GET /api/admin/overview`. Les piliers passent par `/api/{school|business}/<chemin>` → `<service>/<chemin>`.
- Erreurs : `{"ok":false,"error":{"code","message"}}` avec les codes TS (UNAUTHENTICATED 401, FORBIDDEN_ROLE 403,
  CSRF_VALIDATION_FAILED 403, RATE_LIMIT_EXCEEDED 429, RATE_LIMIT_UNAVAILABLE 503, UPSTREAM_UNAVAILABLE 502…).
- Interne : en-têtes `x-solob-service-secret`, `x-solob-user-id`, `x-solob-user-role`, `x-solob-user-email`.
  Chaque service revérifie le rôle (défense en profondeur).
- Mutations proxifiées : CSRF obligatoire + 60/min/utilisateur.

## 4. Plan de migration module par module
1. Core Rust (fait) → 2. School : catalogue/profil (fait), notation via C++ (FFI ctypes ou CLI), documents,
explications → 3. Business : cycle projet → talents → tâches → livraison → rémunération (sans paiement réel)
→ 4. Admin → 5. UI HTML complète → 6. Bascule : même base, même hachage scrypt (compatibilité Node testée),
donc les sessions/utilisateurs existants restent valides ; retour arrière = redéployer l'app TS.

## 5. Cas de test (p.60-62)
Niveaux (p.60) : unitaire (crypto, RBAC, en-têtes, C++ grading), intégration (Rust/Python/Java contre PG 16 réel),
système (scénario e2e curl à travers la passerelle). Cas avec valeurs limites (p.62) : réponse de 15/40 caractères,
budget −1, titre de 2 caractères, 11ᵉ tentative de login, 8 bootstraps simultanés → 1 succès. Régression (p.62) :
le hash scrypt produit par Node doit toujours permettre le login.

| ID | Objectif | Données | Attendu | Obtenu |
|---|---|---|---|---|
| CT-01 | Rôle privilégié refusé à l'inscription | role=admin/operator/reviewer/teacher | 403 PRIVILEGED_ROLE_FORBIDDEN, 0 user | OK |
| CT-02 | CSRF | logout sans/mauvais en-tête ; Origin étranger | 403 | OK |
| CT-03 | Rate limit atomique | 50 appels concurrents, limite 10 | exactement 10 acceptés | OK |
| CT-04 | Bootstrap unique | 8 appels concurrents | 1 OK, 7 ADMIN_ALREADY_BOOTSTRAPPED | OK |
| CT-05 | Secret de service | appel direct sans secret / secret vide configuré | 401 | OK |
| CT-06 | Upsert profil concurrent | 6 requêtes parallèles | 1 seule ligne | OK |
| CT-07 | Notation | réponse vide, 15/40 car., mots-clés | barème TS | OK |

## 6. Risques
- Schéma partagé entre 3 langages : une migration casse potentiellement 3 services → migrations uniquement via la passerelle, tests d'intégration des 3 services en CI.
- Divergences volontaires vs TS : organisation auto-créée `verified=FALSE` (TS : TRUE) ; upsert profil atomique ; CSP plus stricte ; note C++ borne max<0 à 0.
- Le secret de service est un secret partagé unique : à remplacer par mTLS ou jeton signé court par requête avant production.
- Pas de pool JDBC (connexion par requête) côté Java ; pas de pool psycopg côté Python → à ajouter.
- L'UI sans JS limite l'interactivité (upload, retours dynamiques) ; acceptable mais à valider avec les utilisateurs.
- Fonctions IA (explications, génération) restent en mode MOCK sans clé ; aucune clé n'est fournie.
