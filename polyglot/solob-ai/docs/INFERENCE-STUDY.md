# Étude: fournisseur interne `solob-local`

## Options comparées
| Critère | Rust + candle | C++ + ggml / llama.cpp |
|---|---|---|
| Sécurité mémoire | Forte (Rust sûr) | Faible par défaut (C++), surface d'attaque plus grande |
| Performance CPU | Bonne (SIMD, quantification partielle) | Très bonne, référence pour CPU (quantification 4–8 bits mature) |
| Format modèle | safetensors natif ; architecture GPT à écrire (~200 lignes) | GGUF ; conversion PyTorch→GGUF à écrire pour notre architecture custom |
| Intégration passerelle | Même langage que gateway-rust (axum, sqlx, tracing partagés) | Processus/FFI séparé ; grading-cpp montre le modèle « processus lancé » |
| Maintenance équipe | Une stack Rust déjà présente | Une deuxième base C++ critique à maintenir |
| Maturité écosystème | Plus jeune | Très mature, large communauté |

## Contrat d'intégration (identique quelle que soit l'option)
- **Appelant**: School (Python) via le fournisseur `solob-local`, au même titre que le mode démo actuel.
- **Authentification interservices**: même secret partagé ≥ 32 caractères que les autres services internes; écoute
  sur réseau interne uniquement; jamais exposé par la passerelle publique.
- **Limites**: conserver la limite existante de 30 appels/min/utilisateur côté School + plafond `max_new_tokens`
  et taille de prompt côté fournisseur.
- **Journal**: une ligne `ai_usage_records` par appel (fournisseur `solob-local`, tokens prompt/complétion,
  latence, statut) — **sans** stocker le texte de l'élève (seulement une empreinte SHA-256 si besoin d'audit).
- **Délais**: budget dur (ex. 5 s) ; au-delà, statut `timeout` et repli vers le mode démo avec message clair.
- **Erreurs**: statuts `ok | timeout | error` normalisés ; aucune trace interne renvoyée à l'utilisateur.
- **Confidentialité**: pas d'entraînement sur les requêtes des élèves sans consentement explicite et base légale.

## Recommandation
1. **Maintenant**: aucun serveur. Validation hors ligne par `python -m solob_ai.inference.offline_eval`
   (même contrat: délai, statuts, enregistrement d'usage sans texte).
2. **Quand un modèle mérite d'être servi** (pas avant G1/G2): **Rust + candle**, pour la sécurité mémoire et la
   cohérence avec la passerelle. Réévaluer llama.cpp si la quantification 4 bits sur CPU devient indispensable.
