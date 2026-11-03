# Rapport Mission 2 — Fondations IA SOLOB (branche `ai/solob-foundations`, non poussée)

## Phase 0 — Environnement
venv uv Python 3.12, `requirements.lock` hashé (torch 2.5.1+cpu, sentencepiece, tokenizers, numpy, datasketch, pyyaml, psycopg, pytest). CPU seul, 0 $.

## Phase 1 — SAKC (corpus) : sources et licences
Source unique : Wikipedia via le dataset HF `wikimedia/wikipedia` (dump 20231101), API rows de datasets-server.
Licence : CC BY-SA 4.0 (siteinfo/rightsinfo MediaWiki de chaque wiki) + tags HF `cc-by-sa-3.0`, `gfdl`. Preuve : `data/raw/wikipedia/<lang>.proof.json` (URL, licence, date).
Pas de manuels ni d'examens. Une ressource n'entre dans les splits que si elle est `rights_verified`.

| langue | articles collectés | texte | lignes du dump | train/val/test (docs) |
|---|---|---|---|---|
| fr | 190 | 2,00 Mo | 2,56 M | 172/6/9 |
| en | 432 | 2,00 Mo | 6,4 M | 387/25/19 |
| fon | 585 | **0,50 Mo (dump entier : 705 lignes)** | 705 | 519/23/25 |
| yo | 1131 | 2,00 Mo | 33 819 | 1009/54/51 |
| ha | 826 | 2,00 Mo | 36 492 | 745/43/37 |
| wo | 309 | 2,03 Mo | 1 746 | 271/13/15 |
| sw | 1288 | 2,00 Mo | 78 587 | 1148/78/51 |
| ig | 620 | 2,00 Mo | 22 908 | 550/27/37 |

Rejets : 4 doublons exacts, 23 quasi-doublons (MinHash 0,8), 35 avec un ratio de lettres faible, 3 avec des lignes répétées, 2 trop courts. Total : 4801 train / 269 val / 244 test, chaque shard ayant son SHA-256 (MANIFEST.json).
Migration `db/migrations-ai/004_sakc.sql` : additive, sans DROP, idempotente, testée sur PG16.4. Elle a été déplacée hors de `db/migrations/` parce que l'app legacy l'appliquait automatiquement, ce qui cassait EXT-1. Après le déplacement, les 43 tests TS passent.

## Phase 2 — Labo tokenizer (mesuré, unigram/BPE/byte-BPE × 4k/8k/16k)
Chaque cellule donne caractères/token puis parité vs fr (au-dessus de 1, la langue coûte plus de tokens que fr). Entraînement sur ≤ 800k caractères par langue (fon : 376k). Pic RSS : 589 Mo.

| variante | fr | en | fon | yo | ha | wo | sw | ig | unk max | roundtrip |
| bpe_4000 | 2.59/1.00 | 2.61/0.99 | 2.46/1.05 | 2.34/1.10 | 2.71/0.95 | 2.65/0.97 | 2.65/0.98 | 2.75/0.94 | 0.00026 | 6/8 |
| bpe_8000 | 2.97/1.00 | 3.00/0.99 | 2.84/1.05 | 2.71/1.10 | 3.13/0.95 | 3.04/0.97 | 3.11/0.95 | 3.27/0.91 | 0.00031 | 6/8 |
| bpe_16000 | 3.40/1.00 | 3.41/1.00 | 3.19/1.06 | 3.05/1.11 | 3.54/0.96 | 3.39/1.00 | 3.60/0.94 | 3.75/0.91 | 0.00036 | 6/8 |
| unigram_4000 | 2.41/1.00 | 2.49/0.97 | 2.37/1.01 | 2.24/1.08 | 2.63/0.92 | 2.54/0.95 | 2.56/0.94 | 2.62/0.92 | 0.00000 | 8/8 |
| unigram_8000 | 2.75/1.00 | 2.84/0.97 | 2.62/1.05 | 2.54/1.09 | 3.01/0.92 | 2.86/0.96 | 3.00/0.92 | 3.06/0.90 | 0.00000 | 8/8 |
| unigram_16000 | 3.09/1.00 | 3.19/0.97 | 2.85/1.08 | 2.83/1.09 | 3.36/0.92 | 3.12/0.99 | 3.45/0.89 | 3.36/0.92 | 0.00000 | 8/8 |
| bytebpe_4000 | 2.50/1.00 | 2.60/0.96 | 2.40/1.04 | 2.24/1.12 | 2.74/0.91 | 2.61/0.96 | 2.68/0.94 | 2.70/0.93 | 0.00000 | 8/8 |
| bytebpe_8000 | 2.79/1.00 | 2.94/0.95 | 2.67/1.04 | 2.48/1.12 | 3.06/0.91 | 2.91/0.96 | 3.06/0.91 | 3.08/0.91 | 0.00000 | 8/8 |
| bytebpe_16000 | 3.13/1.00 | 3.26/0.96 | 2.90/1.08 | 2.70/1.16 | 3.40/0.92 | 3.16/0.99 | 3.49/0.90 | 3.40/0.92 | 0.00000 | 8/8 |

Choix : **unigram_8000**. Il a un taux d'unk de 0, un aller-retour exact dans les 8 langues et une taille compatible avec un modèle de ~3 M de paramètres. BPE (HF) produit des unk et ne fait pas l'aller-retour exact pour en et fon. Yoruba et fon restent les langues les plus coûteuses (parité de 1,05 à 1,10).

## Phase 3 — Entraînement réel (exécuté, CPU)
Modèle GPT de 3 358 080 paramètres (d=192, 4 couches, 4 têtes, ff 768, contexte 256, vocab 8000), batch 16, 3000 pas, AdamW et cosine.
Tokens d'entraînement : ~4,08 M. Durée : **12,3 min**. RSS max : **1072 Mo**.
Perte train : de 9,007 (pas 1) à 4,57 (pas 3000). Perte val : 4,997 au pas 1500, puis **4,723 (ppl 112,5)** au pas 3000.

Perplexité par langue (pas 3000) :

| langue | ppl val | ppl test | bits/caractère (test, estimé) |
|---|---|---|---|
| fr | 115,6 | 86,7 | 2,34 |
| en | 140,4 | 136,4 | 2,50 |
| fon | 110,9 | 77,6 | 2,40 |
| yo | 121,8 | 126,3 | 2,76 |
| ha | 123,4 | 120,3 | 2,30 |
| wo | 123,7 | 137,2 | 2,49 |
| sw | 95,8 | 96,9 | 2,20 |
| ig | 82,6 | 73,0 | 2,02 |

Les perplexités ne sont pas comparables d'une langue à l'autre (les tokenisations diffèrent). Il faut regarder les bits par caractère. Les splits fr et fon sont minuscules (6 à 25 documents), donc la variance est forte.

## Phase 4 — Évaluation et inférence
`benchmarks/items.draft.jsonl` contient 10 items, tous en **brouillon, NON VALIDÉS** : aucun expert ne les a relus, donc aucun score de benchmark n'est publié. L'éval offline (« Le Bénin est », fr) donne status ok, 40 tokens en 152 ms, et un texte **incohérent** (« uni en Premier 3, et les trois hommes classiques ambigulifiaindare… »). Les journaux d'usage ne stockent que le SHA-256 du prompt.

## Phase 5 — Documentation
Voir `docs/` : ARCHITECTURE-AI, HARDWARE, GPU-PLAN (coûts indicatifs, rien n'est engagé), INFERENCE-STUDY, TOKLAB-RESULTS, ainsi que README.md.

## Tests
pytest solob-ai : 47 passés, 1 ignoré (test PG sans DSN). Avec un DSN PG16, les 2 tests de migration passent. Les 43 tests TS legacy passent. Les suites Rust, Python, Java et C++ ne sont pas touchées (004 hors de leur chemin) et n'ont pas été relancées.

## Risques et limites honnêtes
- Le modèle est un **prototype jouet**. Il n'est ni utile ni capable de raisonner, et ne « maîtrise » aucune langue.
- Corpus encyclopédique uniquement (pas de contenu scolaire), ~14,5 Mo au total. Fon limité à 0,5 Mo. Les articles Wikipedia en wo, yo et ig peuvent être bruités ou générés par bot.
- Pas encore de mesure sur un corpus scolaire, ni de benchmark validé par des experts.
- La licence CC BY-SA impose l'attribution et le partage à l'identique pour toute redistribution d'un dérivé.

## Prochaines étapes
Faire relire les items par des experts. Trouver d'autres sources ouvertes vérifiées (par exemple des textes scolaires sous CC-BY, des ressources fon). Lancer un entraînement GPU-small selon GPU-PLAN, après approbation du budget. Ajuster le tokenizer pour yo et fon.
