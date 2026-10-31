# Plan du prochain entraînement — SOLOB AI (après Mission 3)

Point de départ mesuré (voir `LINGUISTIC-REPORT-V1.md`): v1 (données v1 + tokenizer v1) n'améliore pas v0 de façon nette;
il gagne en fr/en/sw et perd en fon/yo/ha/wo/ig, très probablement à cause du mélange de données (fr+en 31 % → 73 % des tokens).
Budget: zéro (CPU box + éventuellement Kaggle gratuit, voir `GPU-NEEDS-STUDY.md`).

## Hypothèses
- **H1 (mélange):** rééchantillonner les langues par température (p_l ∝ n_l^α, α = 0,3–0,5) récupère le niveau v0 en langues africaines sans perdre le gain fr/en.
- **H2 (tokenizer):** à données et mélange identiques, le tokenizer v1 8k donne un BPC ≤ v0 (il est plus compact sur 6/8 langues, UNK 0, tons préservés).
- **H3 (vocabulaire):** 16k améliore le BPC des langues à forte morphologie/diacritiques (yo, ig) malgré +1,5 M paramètres d'embeddings.
- **H4 (filtrage):** exclure les documents gabarit/stub améliore le BPC sur un test propre (à vérifier contre « tout garder »).
- **H5 (échelle):** à corpus constant (~20 M tokens), passer de 3,4 M à ~10–25 M paramètres réduit le BPC tant que le nombre d'époques reste ≤ 4.

## Ablations (une variable à la fois, seed fixe + 2 seeds pour les finalistes)
| ID | Tokenizer | Données / mélange | Modèle | Budget | Coût estimé |
|---|---|---|---|---|---|
| A0 | v0 8k | v1 filtré, mélange naturel | 3,4 M | 12,3 M tok | ~12 min CPU |
| A1 | v1 8k | v1 filtré, mélange naturel | 3,4 M | 12,3 M tok | fait (run_cpu_v1) |
| A2 | v1 8k | v1 filtré, température α=0,3 | 3,4 M | 12,3 M tok | ~12 min CPU |
| A3 | v1 8k | v1 filtré, α=0,5 | 3,4 M | 12,3 M tok | ~12 min CPU |
| A4 | v1 16k | meilleur de A2/A3 | ~4,9 M | 12,3 M tok | ~15 min CPU |
| A5 | v1 8k | v1 **non** filtré, meilleur α | 3,4 M | 12,3 M tok | ~12 min CPU |
| A6 | meilleur | meilleur | ~10–25 M | 40–80 M tok | 2–10 h CPU ou < 1 h T4 Kaggle |
A0 vs A1 isole le tokenizer (H2); A1 vs A2/A3 le mélange (H1); A4 le vocabulaire (H3); A5 le filtrage (H4); A6 l'échelle (H5).

## Protocole d'évaluation (fixé avant de lancer)
1. **BPC exact par langue** sur le held-out commun SAKC v1 test (⊇ test v0) **et** sur le sous-ensemble test v0, avec `bpc_common.py`. Rapport micro + macro.
2. Tokenizer: chars/token, UNK, roundtrip (strict et modulo espaces), préservation des diacritiques fon/yo — `toklab/v1.py`.
3. Benchmark éducatif: uniquement à titre de contrôle de non-régression, toujours **NON PUBLIABLE** tant que les items ne sont pas validés par des experts (kappa ≥ 0,6, double relecture).
4. Ressources: durée, RSS max, paramètres. 2 seeds pour tout résultat retenu; écart entre seeds rapporté.
5. Rien n'est écrasé: chaque run dans `artifacts/run_*` distinct; manifeste v0 revérifié à chaque étape.

## Critères go / no-go
- **GO pour retenir une configuration** si: BPC macro (v1 test) ≤ meilleur actuel − 0,05 **et** aucune langue ne régresse de plus de +0,05 BPC
  sur le sous-ensemble test v0, de façon reproductible sur 2 seeds (écart entre seeds < gain).
- **GO pour demander des heures GPU (Kaggle gratuit d'abord)** si: A6 montre un gain d'échelle ≥ 0,1 BPC macro **et** le corpus sous licence a augmenté
  (objectif ≥ 50 M tokens, dont fon ≥ 1 M) — sinon un plus gros modèle ne ferait que surapprendre.
- **NO-GO / pause entraînement** si aucune ablation A0–A5 ne passe le premier critère: prioriser alors la collecte de données sous licence et la relecture humaine.
- Toute dépense payante reste soumise à l'accord explicite de Koami.
