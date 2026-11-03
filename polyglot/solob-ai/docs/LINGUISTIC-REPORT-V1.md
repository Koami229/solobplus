# Rapport linguistique v1 — tokenizer et modèle CPU (Mission 3, étape 6)

> Résultats **mesurés** sur la machine actuelle (8 vCPU, sans GPU), 2026-10-31. Modèles minuscules (3,36 M paramètres):
> ces chiffres comparent des prototypes, ils ne démontrent aucune « maîtrise » d'une langue. Benchmark: NON PUBLIABLE.

## 1. Tokenizer v1
**Données d'entraînement.** SAKC v1 *train* uniquement, après exclusion des documents marqués `gabarit_dominant` ou
`stub_court_wikipedia` par la boîte à outils qualité (989 documents exclus sur 21 359; surtout sw 414, yo 212, ha 144, fon 73).
Choix: **exclusion** plutôt que sous-pondération — plus simple, traçable (liste dérivée de `data/sakc/v1/quality/flags.jsonl`) et
les documents exclus sont justement ceux qui apprennent des pièces de gabarit au tokenizer. Plafond **2 M caractères par langue**
(v0: 0,8 M), documents tirés dans un ordre pseudo-aléatoire stable (sha256), pour équilibrer les langues: fon (0,56 M) et wo (1,6 M)
sont utilisés en entier, les autres langues plafonnées à 2 M. Unigram SentencePiece, mêmes options que v0 (couverture 1.0,
normalisation identité, byte-fallback, symboles `<lang_x>`). Script: `solob_ai/toklab/v1.py`; modèles: `artifacts/toklab_v1/` (non versionné).
Le tokenizer v0 n'est que lu (sha256 vérifié avant/après, et manifeste v0 revérifié: 56/56 fichiers intacts).

**Held-out fixe:** SAKC v1 *test* complet par langue (contient tout le test v0), 31 415 lignes non vides.

### Caractères par token (plus haut = plus compact)
| Langue | v0_unigram_8000 | v1_unigram_8000 | v1_unigram_16000 | v1_unigram_32000 |
|---|---|---|---|---|
| fr | 2.554 | 2.710 | 3.066 | 3.414 |
| en | 2.802 | 2.924 | 3.331 | 3.714 |
| fon | 2.578 | 2.566 | 2.866 | 3.128 |
| yo | 2.640 | 2.713 | 3.066 | 3.406 |
| ha | 3.067 | 3.084 | 3.526 | 3.920 |
| wo | 2.890 | 2.838 | 3.164 | 3.406 |
| sw | 3.074 | 3.239 | 3.830 | 4.386 |
| ig | 3.073 | 3.144 | 3.510 | 3.771 |
Pour **toutes** les variantes et toutes les langues:
- **UNK = 0** (byte-fallback);
- **diacritiques tonals fon/yo préservés à 100 %** au décodage (comptage des marques combinantes NFD + lettres ɖ ɛ ɔ…);
- **roundtrip exact modulo espaces = 100 %** des lignes;
- **roundtrip strictement exact ≈ 70–86 % des lignes, identique pour v0 et v1**. Toutes les différences sont des espaces multiples ou de bord fusionnés par SentencePiece (`remove_extra_whitespaces`) — vérifié: 7 873 / 7 873 lignes différentes ne diffèrent que par les espaces. Ce n'est pas « sans perte » au sens strict; à corriger dans une v2 si l'on veut un roundtrip octet par octet.
- Taux de repli octet ≤ 0,15 % (fr: 1,07 % en v0 → 0,12 % en v1).

**Lecture.** À taille égale (8k), v1 est plus compact que v0 sur 6 langues sur 8 (fr +6 %, en +4 %, sw +5 %, yo +3 %, ig +2 %, ha +0,6 %),
légèrement moins compact en fon (−0,5 %) et wo (−1,8 %), pour lesquelles v1 n'a presque pas plus de données que v0.
16k et 32k gagnent respectivement 11–18 % et 20–35 % de caractères/token par rapport à v1 8k, au prix d'une matrice d'embeddings 2×/4× plus grosse (non testé en entraînement).
Mots tonals fréquents (300 mots yo/fon les plus fréquents portant un diacritique): yo 1,38 → **1,06** tokens/mot (v0 → v1 8k), fon 2,05 → 2,02.

## 2. Caractéristiques orthographiques du corpus v1 filtré (mesurées)
| Langue | Docs | Caractères | Marques combinantes / 100 car. | % de mots avec diacritique | Docs non-NFC |
|---|---|---|---|---|---|
| yo | 1 681 | 2,39 M | 24,65 | 64,4 % | 0 |
| ig | 1 319 | 2,66 M | 9,08 | 33,3 % | 0 |
| fon | 612 | 0,56 M | 6,24 | 25,7 % | 0 |
| wo | 592 | 1,60 M | 3,07 | 14,4 % | 0 |
| fr | 4 756 | 18,66 M | 2,43 | 13,6 % | 0 |
| ha | 1 492 | 2,77 M | 0,03 | 0,1 % | 0 |
| sw | 3 633 | 5,72 M | 0,02 | 0,1 % | 0 |
| en | 6 285 | 20,39 M | 0,06 | 0,3 % | 0 |

Le haoussa du corpus est écrit sans marques de ton/longueur (orthographe courante), ce qui est normal mais limite l'évaluation tonale aux langues yo/fon/ig.
Le fon reste la langue la plus pauvre (0,56 M caractères) malgré la priorité accordée: c'est la contrainte principale.

## 3. Modèle CPU v1 vs v0 (même architecture, même budget)
- Architecture identique: GPT 3 358 080 paramètres (vocab 8000, d=192, 4 couches, 4 têtes, seq 256), 3000 pas × 16 × 256 = 12,3 M tokens, lr 1e-3, seed 1234.
- v1: données SAKC v1 filtrées + tokenizer v1 8k; **10,2 min**, RSS ≈ 1,2 Go; val_ppl finale 112,76 (sur val v1 — non comparable à 112,5 de v0, tokenizers et val différents).
- Métrique comparable: **bits par caractère (BPC) exacts**, chaque modèle avec son tokenizer, sur le même texte (`solob_ai/evaluation/bpc_common.py`).

### BPC (plus bas = meilleur)
| Langue | v0 (v1 test complet) | v1 (v1 test complet) | Δ v1−v0 | v0 (sous-ensemble test v0) | v1 (sous-ensemble test v0) | Δ |
|---|---|---|---|---|---|---|
| fr | 2.9891 | 2.4233 | -0.5658 | 2.3354 | 2.5152 | +0.1798 |
| en | 2.7409 | 2.3327 | -0.4082 | 2.4985 | 2.5455 | +0.0470 |
| fon | 2.8546 | 3.0079 | +0.1533 | 2.4008 | 2.9404 | +0.5396 |
| yo | 2.8199 | 2.9115 | +0.0916 | 2.7545 | 3.0510 | +0.2965 |
| ha | 2.3492 | 2.5165 | +0.1673 | 2.2956 | 2.5832 | +0.2876 |
| wo | 2.5646 | 2.8235 | +0.2589 | 2.4840 | 2.8248 | +0.3408 |
| sw | 2.4043 | 2.3004 | -0.1039 | 2.1962 | 2.3475 | +0.1513 |
| ig | 2.2597 | 2.3547 | +0.0950 | 2.0178 | 2.3007 | +0.2829 |
| **micro (pondéré chars)** | 2.7134 | 2.4211 | -0.2923 | 2.3229 | 2.5711 | +0.2482 |
| **macro (moyenne langues)** | 2.6228 | 2.5838 | -0.0390 | 2.3728 | 2.6385 | +0.2657 |
Documents: v1 test complet fr 251, en 329, fon 38, yo 92, ha 86, wo 35, sw 168, ig 86; dont test v0: 9, 19, 25, 51, 37, 15, 51, 37.

**Interprétation honnête — pas d'amélioration nette:**
- v1 est meilleur sur le test v1 complet en **fr, en, sw** (et en micro-moyenne, dominée par fr/en), mais **moins bon sur fon, yo, ha, wo, ig**.
- Sur le sous-ensemble test v0, v1 est **moins bon dans toutes les langues** (+0,25 BPC en micro).
- Cause principale probable: le **mélange des données** a changé, pas seulement le tokenizer. En v0, le budget de 12,3 M tokens couvrait ≈ 3 époques
  d'un corpus équilibré (fr+en = 31 % des tokens, fon 3,6 %). En v1, il couvre 0,62 époque d'un corpus dominé par fr+en (73 %, fon 1,1 %):
  chaque langue africaine a reçu 2 à 5 fois moins de tokens d'entraînement. Le test v0 provient en outre des mêmes sources que le train v0.
- Cette comparaison **ne permet donc pas d'isoler l'effet du tokenizer**; l'ablation correspondante est planifiée dans `NEXT-TRAINING-PLAN.md`
  (même mélange, tokenizer v0 vs v1; puis rééchantillonnage par température).

## 4. Benchmark éducatif (brouillon) — NON PUBLIABLE
v1 évalué avec le harnais (67 items fr/en machine-draft, 96 items placeholders ignorés, décodage glouton 32 tokens): **0,0 sur les 8 pistes**,
comme v0. Attendu pour un modèle de 3,4 M paramètres sans instruction; ne dit rien de la qualité linguistique. Résultat: `data/bench/v1_cpu_draft.json` (non versionné).

## 5. Reproduire
```
python -m solob_ai.toklab.v1 --vocabs 8000,16000,32000                       # artifacts/toklab_v1/results.json
python -m solob_ai.model.data --corpus data/sakc/v1_train_filtered --tokenizer artifacts/toklab_v1/unigram_8000.model --out artifacts/data_v1
python -m solob_ai.model.train configs/cpu_v1.yaml
python -m solob_ai.evaluation.bpc_common --model v0=artifacts/run_cpu_v0/last.pt:artifacts/toklab/unigram_8000.model \
       --model v1=artifacts/run_cpu_v1/last.pt:artifacts/toklab_v1/unigram_8000.model --out artifacts/eval_v1/bpc_common.json
```
`data/sakc/v1_train_filtered/` = train v1 moins les 989 documents exclus; val/test copiés tels quels.
