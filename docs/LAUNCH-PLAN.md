# SOLOB+ — Plan de lancement

Statut : PLAN, rien n'est poussé ni déployé. Rédigé le 31/10/2026 (heure de Porto-Novo, UTC+1).
Branche source : `ai/mission3-educational` (91002dd). `main` local = a100cd5.

## 0. État constaté du dépôt distant `Koami229/solobplus`
- Il existe, il est **public** (description « One Leg in School One Leg In Business ») et a été créé le 31/10/2026 à 09:55 (UTC+1).
- Il est **vide** : `git ls-remote` ne renvoie aucune référence et la taille est 0. Il n'y a ni branche, ni licence, ni README distant.
- Branche par défaut annoncée : `main`. Elle sera créée au premier push.
- La détection de secrets et la protection anti-push de secrets sont activées. Dependabot est désactivé.
- Le connecteur GitHub dispose des droits admin/push. Il peut lire, créer des branches ou PR à partir de commits **déjà présents** sur GitHub et régler les paramètres. Il ne sait pas envoyer l'historique git local.
- Sur la machine, `gh` n'est pas connecté et aucun gestionnaire d'identifiants git n'est configuré. Il n'y a pas de remote `origin`.
- **Conséquence :** aujourd'hui, aucun push git n'est possible. Le dépôt distant étant vide, il n'y a pas de divergence avec `main` : un premier push normal suffit, sans force.

## Branches locales
| Branche | Tête | Proposition |
|---|---|---|
| main | a100cd5 | pousser en premier (base) |
| rewrite/polyglot | 76ca298 | pousser puis PR → main |
| ai/solob-foundations | 6016412 | pousser (historique) |
| ai/mission3-educational | 91002dd | pousser puis PR → main après rewrite/polyglot |
| launch/plan | ce document | pousser, PR docs |
| security/*, mcdl/critical-hardening | déjà fusionnées dans main ? à vérifier | pousser seulement si utiles |

Point d'attention : `main` contient encore l'application Next.js/TypeScript d'origine. La migration polyglotte (Rust/Python/Java/C++) se trouve sur `rewrite/polyglot`. Le retrait du JS de `main` se fera par PR, jamais par réécriture d'historique.

---

## Phase A — Mise en place GitHub
- **Objectif :** historique local sur GitHub, sans force-push, avec une CI qui tourne sur chaque PR et `main` protégée.
- **Fichiers :** `.github/workflows/ci.yml` (existe, à adapter au polyglotte), `LICENSE` (code), `DATA-LICENSE` (CC BY 4.0 pour les contributions), `CONTRIBUTING.md`, `CODEOWNERS`, `.github/dependabot.yml`.
- **Dépendances :**
  - un moyen d'authentification choisi par Koami : (1) Koami pousse lui-même depuis son ordinateur, (2) un token fin limité à ce seul dépôt, saisi par lui et jamais stocké dans le dépôt, ou (3) une clé de déploiement SSH en écriture ;
  - un scan de secrets sur tout l'historique (45 commits) avant le premier push, car le dépôt est public.
- **Ressources :** GitHub Actions gratuit (dépôt public).
- **Tests :** `gitleaks`/`trufflehog` sur l'historique ; CI verte sur la PR.
- **Risques :** secret dans l'historique (le dépôt est public, donc visible de tous) ; jeux de données non licenciés poussés par erreur (`data/` et `artifacts/` sont ignorés : vérifier) ; force-push accidentel.
- **Approbation Koami requise :** méthode d'authentification, liste des branches à pousser, licence du code, réglages de protection (PR obligatoire, CI requise, pas de force-push sur main), activation de Dependabot.

## Phase B — Finir le polyglotte
- **Objectif :** les services gateway-rust, school-python, business-java, grading-cpp et solob-ai se construisent en Docker, passent leurs tests en CI et démarrent avec une graine (seed).
- **Fichiers :** `polyglot/*/Dockerfile` (multi-étapes, non-root), `polyglot/docker-compose.yml`, `db/migrations` (additif), `scripts/seed` (Python), workflow matrice CI (cargo test, pytest, mvn test, ctest) avec un service PostgreSQL 16.
- **Choix du fournisseur d'IA « live » :** garder le mode démo par défaut. Options :
  - API externe gratuite à quotas, à valider côté conditions et données personnelles ;
  - solob-local (phase E).
  - Aucun service payant sans accord.
- **Tests :** suites existantes (School 42, solob-ai 78) ; tests d'intégration via la passerelle ; test de fumée compose.
- **Risques :** images trop lourdes (torch) ; parité fonctionnelle incomplète avec l'application JS (voir `PARITY.md`).
- **Approbation :** fournisseur IA, retrait du JS de main, données de seed.

## Phase C — Système de contributions et groupe de validateurs

> **État (branche `launch/phase-c-contributions`)** — implémenté : migration additive opt-in `db/migrations-ai/006_contributions.sql`
> (contributions CC BY 4.0 avec consentement versionné et horodaté, accord parental pour mineurs, double validation via la file 005,
> réputation, signalements, « réponse utile » School, vue porte des droits `contributions_exportable`), pages Rust `/contribute`
> (CSRF, RBAC, CSP, rate limit, filtre de contenu, retrait sans suppression), endpoint School `POST /feedback`, export
> `python -m solob_ai.contrib.export` (re-vérification Python, lecture seule). Non fait : votes pondérés, rôle `lang_lead` par langue
> (la modération est réservée à `admin`).

- **Objectif :** les utilisateurs proposent du texte, des traductions ou des corrections dans leurs langues, avec un consentement explicite, et des validateurs vérifient.
- **Éléments :**
  - consentement horodaté et versionné ;
  - cession sous **CC BY 4.0**, avec attribution par pseudonyme ou nom au choix ;
  - retrait possible pour les contributions pas encore intégrées à un entraînement ;
  - file de modération ;
  - réputation (points pour une validation acceptée, pondération des votes) ;
  - bouton « Signaler / Améliorer » sur chaque réponse IA ;
  - rôles `contributor`, `validator` et `lang_lead` par langue (fon, yo, ha, wo, ig, sw, fr, en) ;
  - deux validations indépendantes pour accepter ;
  - aucune donnée de mineur sans consentement parental.
- **Fichiers :** migrations additives (`contributions`, `consents`, `reviews`, `reputation_events`, `feedback`), routes School/Python, filtre de contenu, export vers `solob-ai` (pipeline existant `review`).
- **Tests :** consentement obligatoire, double validation, journal d'audit en ajout seul, retrait, limites de débit, anti-spam.
- **Risques :** contenu toxique ou plagié, données personnelles dans les textes, collusion de validateurs, statut juridique des mineurs.
- **Approbation :** texte de consentement, licence, règles de modération, recrutement des validateurs.

## Phase D — Boucle de réentraînement avec garde-fou benchmark
- **Statut :** implémentée sur `launch/phase-d-retraining` (voir `polyglot/solob-ai/docs/PHASE-D-RETRAINING.md`). Fumée CPU seulement ; aucun entraînement massif, rien de déployé.
- **Objectif :** réentraînement périodique sur les données validées. Un modèle n'est promu que s'il ne régresse sur aucune langue.
- **Règle :** BPC sur le held-out commun figé, ne dégrade aucune langue de plus de 0,02, et améliore la moyenne par langue. Benchmark brouillon NON PUBLIABLE tant qu'il n'est pas validé humainement. Ablations A0–A6 d'abord (voir `NEXT-TRAINING-PLAN.md`).
- **Fichiers :** `solob_ai/pipeline/retrain.py`, `promote.py`, manifeste sha256 de chaque modèle, `configs/`.
- **Ressources :** CPU suffisant pour environ 4 M paramètres. GPU gratuit (Kaggle, 30 h/semaine) en option ; voir `GPU-NEEDS-STUDY.md`.
- **Tests :** promotion refusée en cas de régression, reproductibilité (graine), aucune donnée hors licence.
- **Risques :** déséquilibre fr/en (constaté à l'étape 6), surapprentissage, fuite du test dans le train.
- **Approbation :** seuils, cadence, chaque promotion en production.

## Phase E — Serveur d'inférence solob-local (Rust ou C++)
- **Objectif :** exposer `POST /generate` en local (127.0.0.1), attendu par `local_provider.py`.
- **Choix :** Rust (axum + candle) ou C++ (export ONNX / ggml). Recommandation : Rust, déjà utilisé par la passerelle.
- **Fichiers :** `polyglot/solob-local-rs/` et `tools/export_weights.py` (vers safetensors).
- **Tests :** parité des logits avec PyTorch (tolérance 1e-4), limites (512 tokens, délai), charge, refus des adresses non locales.
- **Risques :** qualité actuelle du modèle insuffisante (benchmark 0,0) : rester derrière le drapeau et marquer « brouillon ».
- **Approbation :** activation du drapeau en préproduction.

## Phase F — Hébergement
Comparaison des offres gratuites ou bon marché (à revérifier au moment du choix, les offres changent) :
| Option | Atouts | Limites |
|---|---|---|
| Oracle Cloud Always Free (VM ARM, jusqu'à 4 vCPU / 24 Go) | tout le stack en compose, PG inclus | carte bancaire demandée à l'inscription, capacité aléatoire |
| Fly.io / Render / Koyeb (offres gratuites ou minimales) | déploiement Docker simple | mise en veille, peu de mémoire, PG gratuit limité ou expirant |
| Neon / Supabase (PostgreSQL gratuit) | PG managé | quotas, données hors Afrique |
| VPS bas coût (Hetzner, Contabo…) | prévisible, quelques €/mois | payant, nécessite l'accord |
| Hébergeur local au Bénin | proximité des données (APDP) | à étudier |
- **Démarche :** une préproduction d'abord (compose sur une seule VM, TLS, sauvegardes), puis la production avec le consentement explicite de Koami. Aucune inscription payante sans accord.
- **Approbation :** fournisseur, région, création des comptes (par Koami), domaine.

## Phase G — Avant le lancement
- **Sécurité :**
  - audit OWASP ASVS niveau 1 ;
  - `cargo audit`, `pip-audit`, OWASP dependency-check et SAST ;
  - secrets uniquement dans le gestionnaire de l'hébergeur ;
  - en-têtes de sécurité, limites de débit, rotation des clés.
- **Sauvegardes :** `pg_dump` chiffré quotidien hors site, restauration testée chaque mois, objectifs RPO 24 h et RTO 4 h.
- **Juridique et vie privée — Bénin :**
  - Code du numérique (loi n° 2017-20), livre V sur les données personnelles ;
  - déclaration ou autorisation auprès de l'**APDP** selon les traitements (données d'élèves, mineurs) ;
  - politique de confidentialité, conditions d'utilisation, mentions CC BY ;
  - registre des traitements, droits d'accès, de rectification et d'effacement ;
  - hébergement hors Bénin à analyser au regard des règles de transfert ;
  - revue par un juriste recommandée (non fournie ici).
- **Tests :** test de pénétration léger, exercice de restauration, revue de la politique.
- **Approbation :** textes juridiques, démarche APDP, date de lancement.

## Ordre proposé
A1 (scan secrets) → A2 (push sans force) → A3 (CI + protection) → B → G-sécurité de base → F-préproduction → C → D → E → G complet → F-production.
