# SOLOB AI — Architecture scientifique (Mission 2, prototype)

> Statut: **prototype de recherche**. Aucun modèle utile n'existe à ce stade. Rien n'est branché à SOLOB School en production.

## Principes
- Langages: **Python** (recherche, corpus, tokenizer, entraînement, évaluation). Rust/C++ seulement pour une
  future inférence `solob-local` (voir `INFERENCE-STUDY.md`). Java: aucun rôle IA. Aucun JS/TS.
- PostgreSQL 16 reste la base relationnelle: la migration opt-in `db/migrations-ai/004_sakc.sql` stocke
  uniquement **métadonnées, traçabilité et items de benchmark**. Les textes vivent dans des fichiers versionnés
  (JSONL + `MANIFEST.json` avec SHA-256), hors dépôt git (`data/` ignoré).
- Les services existants (gateway-rust, school-python, business-java, grading-cpp) ne sont **pas modifiés**.
- Même code CPU/GPU: seul le fichier YAML change (`configs/cpu.yaml` vs `configs/gpu-small.yaml`).

## Chaîne
```
Sources ouvertes (licence + preuve) ──► collecte (solob_ai/sakc/collect_*.py)
   ──► registre (sources.json / sakc_sources)
   ──► pipeline (solob_ai/sakc/pipeline.py):
         validation schéma → PORTE DES DROITS (rights_verified seulement) → nettoyage NFC
         → contrôle qualité → doublons exacts (SHA-256) → quasi-doublons (MinHash LSH, J≥0,8)
         → découpage déterministe train/val/test par hachage du contenu → MANIFEST + trace.jsonl
   ──► laboratoire tokenizer (solob_ai/toklab) : BPE / Unigram SentencePiece / BPE octets × 3 vocabulaires
   ──► préparation (solob_ai/model/data.py) : uint16, préfixe <lang_xx>, <eos>
   ──► entraînement (solob_ai/model/train.py) : GPT décodeur causal, AdamW, cosine, checkpoints, reprise exacte
   ──► évaluation (solob_ai/evaluation) : perplexité + bits/caractère par langue ; benchmarks pédagogiques
   ──► validation hors ligne solob-local (solob_ai/inference/offline_eval.py) — aucun serveur
```

## Extensibilité panafricaine
- Une langue = un code ISO 639 + un jeton `<lang_xx>` + une entrée dans `LANGS` du laboratoire.
- Le pays est un champ distinct de la langue (une langue couvre plusieurs pays).
- Les sources non-Wikipédia (manuels autorisés, annales sous licence, dictionnaires) entreront par un collecteur
  dédié **uniquement après** vérification des droits et enregistrement de la preuve (statut `pending_review` sinon).

## Ce qui n'est PAS fait
- Pas de modèle instructionnel, pas d'IA branchée à School, pas de serveur d'inférence, pas d'entraînement massif.
