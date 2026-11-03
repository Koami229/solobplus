# Rapport final — Mission 3 (branche `ai/mission3-educational`)

> Chiffres mesurés sur la machine actuelle (8 vCPU, sans GPU), sauf mention « estimation ». Rien n'a été poussé ni déployé;
> `main` n'a pas été touchée; aucune donnée/artefact supprimé; `data/` et `artifacts/` non versionnés; aucun service payant; aucun secret dans le dépôt.
> La liste des livrables ci-dessous est reconstituée à partir des étapes réalisées.

| # | Livrable | Statut | Commits / fichiers | Mesures clés |
|---|---|---|---|---|
| 1 | Référence v0 figée + audit Mission 2 | ✅ Fait | `faaf634` — `baselines/v0-manifest.json`, `docs/MISSION3-AUDIT.md` | 56 fichiers sha256; revérifié à l'étape 6: 56/56 intacts |
| 2 | Sources ouvertes candidates (licences vérifiées) | ✅ Fait (recherche) | `c035c44` — `docs/MISSION3-SOURCES-CANDIDATES.md` | FLORES+ bloqué (identifiants requis, non utilisés) |
| 3 | Corpus SAKC v1 + provenance | ✅ Fait | `6f5f425` — `docs/SAKC-V1-PROVENANCE.md` | ≈ 55 M caractères train, v0 ⊂ v1 par split |
| 4 | Boîte à outils qualité (signalement seul) | ✅ Fait | `d8e8610` — `docs/QUALITY-REPORT-V1.md` | 0 quasi-doublon inter-splits; 989 docs gabarit/stub signalés |
| 5 | Relecture humaine (migration 005 additive, CLI, pages Rust `/review`) | ✅ Fait | `45a3e6f`, `2c46a9a` + correctif test rejouable (étape 6) | kappa de Cohen, audit append-only |
| 6 | Benchmark éducatif SOLOB (brouillon) | ✅ Fait — NON PUBLIABLE | `ebaeb9e`, `fad266a` — `docs/SOLOB-BENCHMARK.md` | 163 items (67 fr/en, 96 placeholders); v0 et v1: 0,0 partout |
| 7 | Tokenizer v1 + entraînement CPU v1 + comparaison | ✅ Fait — **pas d'amélioration nette** | étape 6 — `solob_ai/toklab/v1.py`, `configs/cpu_v1.yaml`, `solob_ai/evaluation/bpc_common.py`, `docs/LINGUISTIC-REPORT-V1.md` | voir ci-dessous |
| 8 | Fournisseur solob-local dans School (flag off) + étude GPU + plan | ✅ Fait (expérimental) | étape 6 — `school-python/solob_school/local_provider.py`, `docs/GPU-NEEDS-STUDY.md`, `docs/NEXT-TRAINING-PLAN.md` | 8 nouveaux tests School |

## Résultats de l'étape 6
- **Tokenizer v1** (unigram, train v1 filtré, 2 M car./langue): UNK 0, tons fon/yo préservés à 100 %, roundtrip 100 % modulo espaces
  (strict ≈ 70–86 % des lignes, identique à v0 — espaces fusionnés par SentencePiece). À 8k, plus compact que v0 sur 6/8 langues (fr 2,554 → 2,710 car./token).
- **Modèle v1** (3 358 080 param., 3000 pas, 12,3 M tokens, 10,2 min, RSS 1,2 Go). BPC sur held-out commun (v1 test ⊇ v0 test):
  micro 2,713 → **2,421**, macro 2,623 → **2,584** (v0 → v1); mais régression en fon (+0,15), yo, ha, wo, ig, et sur le sous-ensemble test v0 dans toutes les langues (micro +0,25).
  Cause probable: mélange de données dominé par fr/en (73 % vs 31 %) et 0,62 époque vs 3; l'effet du tokenizer seul n'est pas isolé (ablation A0 planifiée).
- **Benchmark brouillon:** 0,0 sur les 8 pistes (NON PUBLIABLE).
- **School solob-local:** désactivé par défaut (`SOLOB_LOCAL_ENABLED`), boucle locale uniquement, mêmes limites (rate limit, longueur de prompt), journal `ai_usage_records` (provider `solob-local`, is_mock FALSE), audit et repli mock / 503 strict en cas d'échec; aucune migration nécessaire (`ai_mode` = `LIVE` existant).
- **Étude GPU:** le corpus (~20 M tokens) est le facteur limitant; compute-optimal ≈ 4 M param. avec 4 époques. Estimations et sources dans `GPU-NEEDS-STUDY.md`.

## Tests
- solob-ai: 78 passés (74 + 4 nouveaux) avec PG16 (`SAKC_TEST_PG_DSN`).
- School: 42 passés (34 existants + 8 nouveaux) sur PG16.
- `test_005_on_postgres` désormais rejouable (identifiants suffixés par run) — passé deux fois de suite sur la même base.

## Limites / suite
Pas de serveur d'inférence solob-local livré (seul le client School et le contrat existent); benchmark à faire valider par des experts;
FLORES+ toujours bloqué; prochaines étapes et critères go/no-go dans `NEXT-TRAINING-PLAN.md`.
