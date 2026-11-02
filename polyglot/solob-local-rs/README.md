# solob-local — serveur d'inférence SOLOB AI (Rust + candle, CPU) — EXPÉRIMENTAL

Sert le modèle **promu** du registre (`artifacts/registry/models.jsonl`) pour le fournisseur
`local_provider.py` de School. Le modèle actuel (smoke-d1, ~3,36 M paramètres) **ne produit pas de
réponses utiles** : chaque réponse est marquée `experimental: true` et l'UI l'affiche « EXPÉRIMENTAL ».

## Sécurité / exploitation
- Désactivé sauf `SOLOB_LOCAL_SERVE=1` ; `SOLOB_LOCAL_BIND` (défaut `127.0.0.1:8300`) doit être une boucle locale.
- Limites : corps 16 KiB, prompt 4000 caractères, `max_new_tokens` ≤ 512, délai 10 s (504), une génération à la fois (503 BUSY).
- Intégrité : `manifest.json` (sha256) vérifié au démarrage ; fichiers modifiés ⇒ refus.
- Journaux JSON structurés **sans contenu utilisateur** (tailles, jetons, latence seulement).
- `GET /healthz` ; `solob-local healthcheck` (utilisé par le HEALTHCHECK Docker).

## API
`POST /generate {"prompt": "...", "max_new_tokens": 64, "lang": "fr"}` →
`{"text", "completion_tokens", "model": "solob-local:<id>", "experimental": true, "notice"}`.

## Export des poids (lecture seule des originaux)
    ../solob-ai/.venv/bin/python tools/export_weights.py --out ../solob-ai/artifacts/solob-local/promoted
Vérifie les sha256 du registre, écrit safetensors + config + tokenizer + jeux de parité + manifeste ;
refuse d'écrire dans un dossier non vide.

## Tests
    SOLOB_LOCAL_PARITY_DIRS=/tmp/fixture:../solob-ai/artifacts/solob-local/promoted cargo test --release -- --nocapture
Parité PyTorch ↔ candle : tokenisation identique, |Δlogits| max ≤ 1e-4, décodage glouton identique.

## Docker / compose
Image distroless non-root (digests épinglés). Profil compose `solob-local` **désactivé par défaut** ;
partage l'espace réseau de `school`. School reste en mode démo tant que `SOLOB_LOCAL_ENABLED` n'est pas 1.
