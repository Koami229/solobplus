# Phase D — Boucle de réentraînement avec porte de promotion

Code : `solob_ai/pipeline/` (Python uniquement). Migration : `db/migrations-ai/007_training_usage.sql` (additive).

| Étape | Commande | Garanties |
|---|---|---|
| 1. Ingestion | `python -m solob_ai.pipeline.ingest --export contributions.jsonl` | Crée `data/sakc/v1.N/` (delta, création atomique, jamais écrasé). Porte des droits revérifiée (refus = id + raison seulement, aucun texte). Qualité = drapeaux seulement. Dédup exacte + MinHash contre v1 train/val/test et les deltas précédents : doublons gardés mais exclus de l'entraînement (pas de fuite du test). Tout en `train` : le test v1 reste figé. |
| 2. Mélange | `mix:` dans la config | Échantillonnage par température `p ∝ n^(1/T)` + plancher/plafond (corrige la domination fr+en constatée en Mission 3). |
| 3. Entraînement | `python -m solob_ai.pipeline.retrain configs/retrain_smoke.yaml` | Même code CPU/GPU (`retrain_gpu.yaml`, NON exécuté). Vérifie v0/v1 par sha256 avant de commencer ; init depuis un checkpoint en lecture seule ; candidat dans un répertoire neuf. |
| 4. Promotion | `python -m solob_ai.pipeline.promote configs/promote.yaml --candidate ID` | BPC par langue sur `data/sakc/v1/test.jsonl` (sha256 figé). Refus si une langue prioritaire régresse de plus de 0,02 BPC, ou si la moyenne pondérée (langues africaines ×2) ne s'améliore pas. Rapport JSON. « promoted » = nouvelle référence interne, PAS un déploiement. Benchmark : NON PUBLIABLE sans validation experte. |
| 5. Registre | `artifacts/registry/models.jsonl` | Ajout seul, chaîné par sha256, hachages des checkpoints/tokenizer/config/deltas ; un id/événement n'est jamais réécrit. |
| 6. Usage | `ai_mark_contributions_trained(run, ids, sha)` | Appelée seulement après ≥ 1 pas d'entraînement réel ; marque `used_in_training_at` si NULL et si approuvée ; journal `contribution_training_audit` en ajout seul (+ journal local `training_audit.jsonl`). |

Intégrité : `python -m solob_ai.pipeline.guard` vérifie `baselines/v0-manifest.json` et `baselines/v1-manifest.json` (gel par hachage de 49 fichiers v1, ajouté en Phase D).

## Fumée CPU réelle (2 nov. 2026, 8 vCPU, sans GPU)

- Aucune contribution réelle n'existe encore : le delta `v1.1` a été créé depuis un export vide et n'est pas utilisé. Le candidat ne diffère de v1 que par 200 pas supplémentaires (≈ 0,8 M jetons, 38 s) avec le mélange rééquilibré (T = 3, plancher 0,05, plafond 0,25 : fon 1,1 % → 6,5 %, fr+en 72,8 % → 41,0 %).
- Perte de validation (mélange naturel) : 4,7388 → 4,7276.
- BPC sur le held-out v1 complet (référence v1 → candidat) : fon 3,0079 → 2,9200 ; yo 2,9115 → 2,8851 ; ha 2,5165 → 2,4954 ; wo 2,8235 → 2,7826 ; ig 2,3547 → 2,3251 ; sw 2,3004 → 2,2925 ; fr 2,4233 → 2,4310 ; en 2,3327 → 2,3382. Moyenne pondérée 2,6373 → 2,6060. Porte : passée (aucune régression > 0,02).
- Les BPC de référence reproduisent exactement ceux de `artifacts/eval_v1/bpc_common.json`.
- Interprétation honnête : petit modèle (3,4 M paramètres), un seul essai, une seule graine, petits held-out (fon : 38 documents). Aucune langue n'est maîtrisée. Ces chiffres ne sont pas publiables.

## Limites connues

- Contrainte héritée de la 006 : `status <> 'withdrawn' OR used_in_training_at IS NULL` empêche de retirer une contribution déjà utilisée. Une décision produit est à prendre (retrait = exclusion des entraînements futurs).
- Ablations A0–A6 (`NEXT-TRAINING-PLAN.md`) non lancées. La cadence et les seuils restent à approuver.
