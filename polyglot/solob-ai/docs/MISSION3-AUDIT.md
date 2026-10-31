# Audit Mission 2 — référence v0 figée (Mission 3, étape 1)

Branche : `ai/mission3-educational` (créée depuis `ai/solob-foundations`). Rien n'a été déplacé, modifié ni supprimé.
Gel : `baselines/v0-manifest.json` contient le SHA-256 de 56 fichiers (tokenizers, checkpoint `last.pt` de 40,3 Mo, shards SAKC v0, preuves de licence, configs, métriques).
Attention : `artifacts/` est ignoré par git. Les poids n'existent donc que sur cette machine ; le manifeste permet de vérifier leur intégrité mais ne les sauvegarde pas.

## Chiffres mesurés (source : REPORT-MISSION2.md, artifacts/run_cpu_v0/ppl.json)
- Corpus : Wikipedia uniquement (dump 20231101, CC BY-SA 4.0), ~14,5 Mo ; 4801/269/244 documents train/val/test.
- fon : 0,50 Mo, 585 articles (l'intégralité du wiki fon) ; autres langues ~2 Mo chacune.
- Tokenizer : unigram 8000, unk 0, aller-retour exact 8/8 langues ; parité vs fr : fon 1,05, yo 1,09.
- Modèle : 3 358 080 paramètres, 3000 pas, ~4,08 M tokens, 12,3 min CPU, RSS max 1072 Mo.
- Perte train 9,007 → 4,57 ; perte val 4,723 (ppl 112,5).
- Bits/caractère test (estimé) : fr 2,34, en 2,50, fon 2,40, yo 2,76, ha 2,30, wo 2,49, sw 2,20, ig 2,02.
- Tests : pytest 47 passés, 1 ignoré (sans DSN PG).

## Forces
- Chaîne complète reproductible : collecte avec preuve de licence → dédup MinHash → splits hashés → tokenizer → entraînement → évaluation.
- Porte `rights_verified` effective ; aucune donnée sans licence dans les splits.
- Tokenizer sans unk ni perte sur les diacritiques fon/yo.
- Migrations additives uniquement ; journaux d'usage sans prompt en clair.

## Faiblesses
- Aucun contenu scolaire : corpus purement encyclopédique.
- fon : volume plafonné par la source (0,5 Mo) ; splits val/test fon et fr minuscules (6 à 25 docs) → forte variance.
- Wikipedias wo/yo/ig possiblement bruitées ou générées par bot (non mesuré).
- Génération incohérente ; aucune capacité pédagogique.
- Benchmark : 10 items brouillon, non validés ; aucun score publiable.
- Poids non versionnés (gitignore), pas de sauvegarde hors machine.
- Perplexités non comparables entre langues ; seul bits/caractère est indicatif.
