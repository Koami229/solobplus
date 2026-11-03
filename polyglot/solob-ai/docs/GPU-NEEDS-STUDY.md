# Étude des besoins GPU — SOLOB AI (Mission 3, étape 6)

> Toutes les durées et tous les coûts ci-dessous sont des **ESTIMATIONS** (calcul théorique + hypothèses d'efficacité),
> pas des mesures, sauf la ligne « CPU box » dont le débit est **mesuré** sur le run v0. Prix relevés le 2026-10-31
> (sources en bas de page); ils changent souvent: à revérifier avant toute dépense. Aucune dépense n'a été engagée.

## 1. Point de départ mesuré
- Run CPU v0/v1: 3,36 M paramètres, 3000 pas × 16 × 256 = 12,3 M tokens en ≈ 12 min sur 8 vCPU (6 threads), RSS ≈ 1,1–1,2 Go.
- Débit effectif mesuré ≈ 6·N·D / t = 6 × 3,36e6 × 12,3e6 / 738 s ≈ **0,34 TFLOP/s**.
- Corpus SAKC v1 (filtré): ≈ 55 M caractères, **≈ 20 M tokens** avec le tokenizer v1 8k (en/fr ≈ 73 %, langues africaines ≈ 27 %; fon ≈ 0,23 M tokens seulement).

## 2. Hypothèses de calcul
- Coût d'entraînement ≈ **6·N·D** FLOP (N paramètres, D tokens) — Kaplan et al. 2020; Hoffmann et al. 2022.
- Budget « Chinchilla » ≈ **20 tokens / paramètre** (Hoffmann et al. 2022).
- Efficacité (MFU) supposée: T4 25 %, A10 35 %, A100 40 %, H100 40 % des pics fp16/bf16 dense
  (T4 65 TFLOPS, A10 125, A100 312, H100 SXM ≈ 989 — fiches NVIDIA). Hypothèse optimiste pour les petits modèles.
- Mémoire d'entraînement (AdamW, précision mixte) ≈ **16 octets / paramètre** hors activations (poids, gradients, 2 moments, copie fp32).
- Répétition de données: jusqu'à ~4 époques, la perte est proche de celle de données uniques (Muennighoff et al. 2023, « Scaling Data-Constrained LMs »); au-delà, rendement décroissant.

## 3. Tailles décodeur seul et budgets
| Modèle | Tokens Chinchilla (20×N) | Ratio vs corpus SAKC v1 (20 M) | Mémoire état d'entraînement (≈16 o/param) | GPU minimum réaliste |
|---|---|---|---|---|
| 25 M | 0,5 G | 25× | 0,4 Go | T4 16 Go (ou CPU, lentement) |
| 125 M | 2,5 G | 125× | 2 Go | T4 16 Go |
| 350 M | 7 G | 350× | 5,6 Go + activations | T4 avec gradient checkpointing; A10 24 Go confortable |
| 1 B | 20 G | 1000× | 16 Go + activations | A100 40/80 Go (T4/A10 seulement avec 8-bit/offload) |

**Conclusion clé: la donnée, pas le calcul, est le facteur limitant.** Avec 20 M tokens × 4 époques ≈ 80 M tokens,
le modèle « compute-optimal » ferait ≈ 4 M paramètres — l'ordre de grandeur du prototype actuel. Entraîner 125 M+ sur SAKC v1
seul entraînerait un fort surapprentissage. Les grands modèles n'ont de sens qu'avec (a) beaucoup plus de données sous licence,
ou (b) l'adaptation d'un modèle ouvert existant (licence à vérifier) plutôt qu'un entraînement à partir de zéro.

## 4. Heures estimées (calcul pur, hors chargement/évaluation)
| Modèle / budget | CPU box (mesuré 0,34 TF/s) | T4 | A10 | A100 | H100 |
|---|---|---|---|---|---|
| 25 M, 0,5 G tok (Chinchilla) | ~62 h | ~1,3 h | ~0,5 h | ~0,2 h | ~0,1 h |
| 25 M, 80 M tok (corpus ×4) | ~10 h | ~0,2 h | ~0,1 h | <0,1 h | <0,1 h |
| 125 M, 2,5 G tok | ~1 550 h | ~32 h | ~12 h | ~4,2 h | ~1,3 h |
| 125 M, 80 M tok | ~50 h | ~1 h | ~0,4 h | ~0,1 h | <0,1 h |
| 350 M, 7 G tok | ~12 000 h | ~250 h | ~93 h | ~33 h | ~10 h |
| 350 M, 80 M tok | ~140 h | ~3 h | ~1,1 h | ~0,4 h | ~0,1 h |
| 1 B, 20 G tok | ~99 000 h | ~2 050 h | ~760 h | ~270 h | ~84 h |
| 1 B, 80 M tok | ~400 h | ~8 h | ~3 h | ~1,1 h | ~0,3 h |

Les lignes « 80 M tok » sont faisables à petit prix mais **sous-entraînées par construction** (≪ 20 tokens/param).

## 5. Options gratuites (aucun service payant engagé)
| Option | Ce qui est documenté | Limites |
|---|---|---|
| **Kaggle Notebooks** | GPU P100 16 Go ou 2× T4 16 Go; quota **30 h GPU / semaine** (parfois plus, « floating quota »), reset samedi 00:00 UTC; sessions max **12 h**; 4 vCPU, ~29 Go RAM; 20 Go disque persistant | file d'attente possible; 2×T4 compte 1 h par heure; données doivent être téléversées (vérifier la licence de redistribution de SAKC avant de publier un dataset Kaggle — utiliser un dataset privé) |
| **Google Colab (gratuit)** | GPU possible (souvent T4) | **aucun quota publié**, type de GPU non garanti, sessions ≤ 12 h, déconnexion si inactif; inadapté aux runs longs reproductibles |
| CPU box actuel | 8 vCPU, ~0,34 TF/s mesurés | suffisant jusqu'à ~10–25 M paramètres sur le corpus actuel |

Avec 30 h/semaine de T4 Kaggle: 25 M (Chinchilla) ≈ 1,3 h, 125 M sur ≥ 1 G tokens ≈ 13+ h (≈ ½ semaine de quota) — **si** les données existaient.

## 6. Coûts estimés en location (ESTIMATIONS, prix publics relevés 2026-10)
| GPU | Prix/h observé (on-demand) | 125 M Chinchilla | 350 M Chinchilla | 1 B Chinchilla |
|---|---|---|---|---|
| T4 | ~0,35 $ (GPU seul, Google Cloud; à vérifier) | ~11 $ | ~90 $ | ~720 $ |
| A10 24 Go | 1,10–1,29 $ (Modal, Lambda) | ~13–15 $ | ~100–120 $ | ~840–980 $ |
| A100 40/80 Go | 0,89–1,99 $ (JarvisLabs, RunPod, Lambda) | ~4–8 $ | ~30–65 $ | ~240–530 $ |
| H100 SXM 80 Go | 3,49–4,29 $ (RunPod/Jarvislabs, Lambda) | ~5 $ | ~36–44 $ | ~295–360 $ |

Hors stockage, transferts, taxes, essais ratés (prévoir ×2–3 pour ablations et reprises).

## 7. Recommandation
1. Rester sur CPU + Kaggle gratuit tant que le corpus fait ~20 M tokens: viser 10–30 M paramètres et des ablations courtes.
2. Priorité aux **données sous licence** (et aux évaluations humaines) plutôt qu'au GPU.
3. Ne demander un budget GPU payant (A100/H100, quelques dizaines de $) qu'après un go/no-go défini dans `NEXT-TRAINING-PLAN.md`.

## Sources (consultées le 2026-10-31)
- Kaggle, *Notebooks docs* (spécifications, 12 h, 2×T4/P100): https://www.kaggle.com/docs/notebooks
- Kaggle, *Efficient GPU usage* (quota hebdomadaire 30 h): https://www.kaggle.com/docs/efficient-gpu-usage
- Kaggle, *Floating GPU quota* (reset samedi UTC): https://www.kaggle.com/product-feedback/173129
- Google Colab FAQ (limites non publiées, 12 h max): https://research.google.com/colaboratory/faq.html
- Lambda pricing: https://lambda.ai/pricing ; agrégateur gpucostlab (relevés 2026-10-07): https://gpucostlab.com/gpu-cloud-prices/ ; Jarvislabs H100 guide: https://jarvislabs.ai/blog/h100-price ; RunPod: https://www.runpod.io/pricing
- Hoffmann et al. 2022, *Training Compute-Optimal LLMs* (arXiv:2203.15556); Kaplan et al. 2020 (arXiv:2001.08361); Muennighoff et al. 2023 (arXiv:2305.16264).
- Pics FLOPS: fiches techniques NVIDIA T4, A10, A100, H100.
