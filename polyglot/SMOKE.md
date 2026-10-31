# Conteneurs, test de fumée et graine de démonstration (Phase B)

> Topologie **locale uniquement**, rien n'est déployé. Aucun secret n'est versionné : `.env` est ignoré par git.

## Images
| Service | Dockerfile | Contexte | Base (épinglée par digest) | Utilisateur | Healthcheck |
|---|---|---|---|---|---|
| gateway (Rust) | `gateway-rust/Dockerfile` | racine du dépôt (embarque `db/migrations`) | `rust:1-bookworm` → `distroless/cc-debian12:nonroot` | `nonroot` | `solob-gateway healthcheck` (GET `/api/health`, BD comprise) |
| school (Python + correcteur C++) | `school-python/Dockerfile` | `polyglot/` | `debian:bookworm-slim` + `python:3.13-slim-bookworm` | `10001` | GET `/health` |
| business (Java 21) | `business-java/Dockerfile` | `business-java/` | `maven:3.9-eclipse-temurin-21` → `eclipse-temurin:21-jre-alpine` | `10001` | GET `/health` |

Toutes les images sont multi-étapes, tournent sans root et sans capacités (`cap_drop: ALL`, `read_only`, `no-new-privileges`). Le service `migrate` (image gateway, commande `migrate`) applique les migrations additives `db/migrations/0*.sql` une fois, sous verrou consultatif, avant le démarrage de School et de Business.

## Lancer en local
```bash
cd polyglot
{ echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"; echo "SESSION_SECRET=$(openssl rand -hex 32)";
  echo "SERVICE_SECRET=$(openssl rand -hex 32)"; echo "APP_ENV=staging"; } > .env   # APP_ENV=production par défaut
docker compose --env-file .env up -d --build gateway
# administrateur initial (une seule fois ; ensuite 409 ADMIN_ALREADY_BOOTSTRAPPED)
docker compose --env-file .env run --rm --no-deps -e BOOTSTRAP_ADMIN_EMAIL=moi@example.org \
  -e BOOTSTRAP_ADMIN_PASSWORD='<12+ caractères>' -e BOOTSTRAP_ADMIN_NAME='Admin' gateway bootstrap-admin
```

## Test de fumée de bout en bout
`SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… python3 scripts/smoke_e2e.py` (bibliothèque standard uniquement). Il vérifie :
- la santé de la passerelle et de la BD ;
- les refus attendus (accès anonyme, mauvais mot de passe, POST sans en-tête CSRF) ;
- la connexion admin, avec cookie de session et jeton CSRF ;
- `GET /api/auth`, puis la vue admin ;
- le catalogue School (Python) et l'espace Business (Java) **via le proxy de la passerelle** ;
- la déconnexion et la révocation de la session.

## Graine de démonstration (`scripts/seed_demo.py`)
- **Données fictives uniquement :** e-mails `@synthetic.solob.local`, textes préfixés `[SYNTHETIC]`. Le mot de passe de démo `SolobSynthetic#2026` est public et ne sert qu'à ces comptes.
- **Contenu :**
  - Core : 8 comptes (admin, opérateur, relecteur, élève, enseignant, client, deux talents) et les drapeaux de fonctionnalités par défaut ;
  - School : profil académique de l'élève (BAC D, SVT) et profil de l'enseignant ;
  - Business : organisation et projet du client (XOF, mode géré) et deux profils de talents (fon, yo).
- **Idempotente :** l'action passerelle `seed_synthetic` ne fait rien si les données existent déjà, et les autres étapes sont des *upserts*. Lancer la graine deux fois ne crée aucun doublon ; c'est vérifié en CI et en local.
- **Non destructive :** passage uniquement par l'API, sans DELETE, TRUNCATE ni DROP.
- **Refusée par la passerelle si `APP_ENV=production`** (`SEED_FORBIDDEN_IN_PRODUCTION`).
- **Usage :** `SEED_ADMIN_EMAIL=… SEED_ADMIN_PASSWORD=… python3 scripts/seed_demo.py`. Le script vérifie ensuite la connexion des 8 comptes et la lecture des données School et Business.

## Fournisseur d'IA « live »
Le **mode démo reste le mode par défaut** : explications déterministes et ancrées dans les sources, sans appel réseau. Options :
1. **solob-local** (recommandé à terme, phase E) : `SOLOB_LOCAL_ENABLED=true` et `SOLOB_LOCAL_URL=http://…` côté School, plus `SOLOB_LOCAL_TIMEOUT_S` et `SOLOB_LOCAL_MAX_NEW_TOKENS`. Sans service joignable, School revient au mode démo, sauf en mode strict. Rien n'est activé tant que le modèle n'est pas prêt.
2. **API externe** (gratuite à quotas ou payante) : **décision de Koami requise**. Il faut valider le coût, les conditions d'utilisation et le traitement des données personnelles, notamment pour les mineurs. **Aucun fournisseur externe n'est configuré.**

## Vérifié et non vérifié
- **Vérifié en local, sans Docker** (binaires natifs et PostgreSQL 16) : migrations, bootstrap admin, test de fumée (11 contrôles), graine lancée deux fois avec des comptes stables et le healthcheck de la passerelle.
- **Vérifié en CI seulement** : construction des images avec buildx, démarrage par compose, contrôle non-root et healthchecks. Voir le job `docker-smoke`. Docker n'est pas installé sur la machine de développement.
