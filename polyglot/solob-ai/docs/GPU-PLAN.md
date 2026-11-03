# Plan de passage aux GPU (indicatif — aucun abonnement, budget actuel 0 $)

Le pipeline ne change pas: `python -m solob_ai.model.train configs/gpu-small.yaml` (device `cuda`, `bfloat16`).
Seuls les fichiers de config et la taille du corpus changent.

| Étape | Modèle | Tokens | Ordre de grandeur calcul (6·N·D) | GPU indicatif | Coût indicatif* |
|---|---|---|---|---|---|
| G0 | 3–5 M (actuel) | 10–20 M | ~1e15 FLOP | CPU suffit | 0 $ |
| G1 | ~25 M | ~500 M | ~8e16 | 1× L4/A10 quelques heures | ~5–20 $ |
| G2 | ~85 M (gpu-small.yaml) | ~2 G | ~1e18 | 1× A100 ~1 jour | ~30–80 $ |
| G3 | ~350 M | ~7 G | ~1,5e19 | 8× A100 ~1–2 jours | ~1 000–3 000 $ |
| G4 | ~1 B | ~20 G | ~1,2e20 | 8× H100 ~1–2 semaines | ~10 000–40 000 $ |

\* Estimations à partir de prix publics de location à l'heure (≈ 0,5–1 $/h L4, ≈ 1,5–3 $/h A100, ≈ 2–4 $/h H100),
efficacité supposée 30–40 %. À re-vérifier au moment voulu; **rien n'a été loué**.

Préalables avant G1: corpus SAKC v1 ≥ 500 M tokens à droits vérifiés (aujourd'hui: ~15 Mo de texte au total),
tokenizer figé, benchmarks relus par des enseignants, procédure de sauvegarde des checkpoints hors machine.
Préalables techniques déjà en place: config par YAML, reprise exacte, `grad_accum`, `dtype`, journal JSONL.
À ajouter pour multi-GPU: DDP (`torchrun`), shards de données mmap, checkpoint distribué.
