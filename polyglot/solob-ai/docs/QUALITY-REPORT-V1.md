# SAKC v1 — Rapport qualité (étape 4, mission 3)

Outil : `solob_ai/sakc/quality/` (`python -m solob_ai.sakc.quality.run data/sakc/v1`), exécuté le 31/10/2026 sur la
version v1 construite à l'étape 3 (23 600 documents = 21 359 train + 1 156 val + 1 085 test). Durée : 12 min 36 s en CPU
(AfroLID 1.5 inclus).

**Mode signalement uniquement : aucun document supprimé ni modifié.** Sorties non versionnées (`data/` est ignoré par git) :
`data/sakc/v1/quality/flags.jsonl` (1 ligne par document signalé), `scores.jsonl` (score pédagogique de chaque document),
`SUMMARY.json` (agrégats ci-dessous).

## Ce que les chiffres veulent dire

* Ce sont des **heuristiques automatiques non validées par des humains**. Un drapeau signifie « à regarder », pas « mauvais ».
  Aucun seuil n'a été calibré sur des annotations humaines : la précision et le rappel sont **inconnus**. Le système de
  relecture humaine (partie B) sert justement à mesurer cela.
* 17 613 documents sur 23 600 ont au moins un drapeau, mais la plupart sont des drapeaux **informatifs** (pays non renseigné,
  origine SMOL, URL http). **2 246 documents** (9,5 %) ont au moins un drapeau de contenu.

## Drapeaux mesurés (nombre de documents)

| Famille | Drapeau | Docs | Lecture |
|---|---|---:|---|
| Provenance | `pays_non_renseigne` | 12 233 | `country=XX` pour en/fr et pour les sources multinationales. Informatif. |
| Origine | `origine_source_generee_llm_traduite_humain` | 3 277 | Tout Google SMOL/SmolDoc : selon la fiche du jeu de données, le côté anglais a été **généré par un LLM** puis traduit par des humains. Signalé pour transparence, pas exclu. |
| Provenance | `url_non_https` | 1 174 | URL `http://` d'African Storybook (lien vers l'histoire). Informatif. |
| Texte généré ou gabarit | `stub_court_wikipedia` | 1 090 | Article Wikipédia de moins de 60 mots. Il s'agit souvent d'ébauches. sw 461, yo 230, ha 158, ig 97, fon 77, wo 39. |
| Texte généré ou gabarit | `gabarit_partiel` (couverture 25–50 %) | 457 | Plus de 25 % des mots du document sont couverts par des 6-grammes présents dans au moins max(20 ; 2 %) des documents de la même source. |
| Texte généré ou gabarit | `gabarit_dominant` (plus de 50 %) | 167 | Signale probablement des articles produits par bot ou modèle. sw 104, fon 33, ha 30. |
| Texte généré ou gabarit | `diversite_lexicale_faible` (TTR300 < 0,35) | 109 | |
| Texte généré ou gabarit | `repetition_trigrammes` (plus de 35 %) | 76 | |
| Texte généré ou gabarit | `phrases_repetees` | 10 | |
| Texte généré ou gabarit | `motif_stub_demographique` | 11 | Population ou recensement dans un article court. |
| Doublons | `quasi_doublon_inter_split` (MinHash 0,8, val/test contre train) | **0** | Aucune fuite train vers val ou test détectée. |
| Linguistique | `ecriture_mixte` (1–10 % de lettres non latines) | 311 | Surtout Wikibooks (formules, grec mathématique). |
| Linguistique | `ecriture_non_latine` (plus de 10 %) | 111 | Surtout Wikibooks fr/en. |
| Linguistique | `yo_sans_tons` (moins de 5 % de voyelles accentuées) | 227 | Wikipédia yo 219. C'est du yoruba sans tons, un vrai problème d'orthographe. |
| Linguistique | `yo_tons_partiels` (5–15 %) | 176 | |
| Linguistique | `yo_sans_points_souscrits` | 45 | |
| Linguistique | `fon_sans_tons` | 37 | Wikipédia fon. |
| Linguistique | `fon_sans_lettres_specifiques` (aucun ɖ, ɛ ou ɔ) | 2 | |
| Linguistique | `caracteres_confusables` | 17 | Par exemple ε grec au lieu de ɛ, ou ð au lieu de ɖ. SMOL 8, Wikipédia yo 6. |
| Linguistique | `langid_desaccord` (AfroLID) | 57 | Uniquement des documents Wikipédia hérités de v0, que le build v1 n'avait pas repassés au langid. Les principaux sont fon→bci 12, yo→som 10, yo→wol 7, yo→ibo 5. |
| Linguistique | `langid_confiance_faible` (moins de 0,5) | 9 | |
| Licence | `licence_hors_liste_blanche`, `licence_nc_nd`, `droits_non_verifies` | **0** | La barrière de droits du build tient. |
| Source | `hash_incoherent`, `url_invalide`, `preuve_introuvable`, `provenance_manque_*` | **0** | Le sha256 a été recalculé pour chacun des 23 600 documents. |

## Score pédagogique (0–100, heuristique)

Le score additionne six composantes : longueur des phrases (20), longueur du document (15), marqueurs didactiques
multilingues (25), structure (listes et questions, 15), diversité lexicale (10) et métadonnées niveau/discipline (15).
Il **n'est pas validé** : il ne sert qu'à prioriser la relecture.

| Source | Médiane | p90 |
|---|---:|---:|
| African Storybook (en, fr, ha, yo) | 60 | 66–75 |
| Wikibooks en / fr | 50 / 45 | 76 / 70 |
| Common Voice | 25 (sw) à 50 (fr) | 30–61 |
| Google SMOL (toutes langues) | 45 | 48–53 |
| Wikipédia fr / en | 45 | 51–59 |
| Wikipédia ha / ig / yo | 35 | 45 |
| Wikipédia fon / wo | 28 | 45 |
| Wikipédia sw | 20 | 45 |

La médiane du TTR300 (diversité lexicale sur fenêtres de 300 mots) va de 0,46 (fon) à 0,58 (sw).

## Limites, et ce qui n'est pas vérifié

* Les seuils (35 %, 0,35, 5 %, 60 mots, etc.) sont fixés a priori et ne sont pas calibrés.
* Les motifs « bot » se limitent à deux expressions régulières génériques. La détection principale de gabarits est calculée
  sur les données. Aucune liste publique de bots des Wikipédias wo, yo ou ig n'a été consultée.
* AfroLID ne couvre ni le français ni l'anglais, qui n'ont donc **aucun** contrôle de langue.
* Le contrôle des tons fon et yo est un ratio de diacritiques. Il ne vérifie pas que les tons sont **justes**.
* Le fon n'a que 756 documents. Les statistiques par drapeau y sont fragiles.
* Recommandations, non appliquées faute de décision :
  * exclure ou sous-pondérer `gabarit_dominant` et `stub_court_wikipedia` pour l'entraînement ;
  * prioriser `yo_sans_tons` pour la relecture ;
  * repasser AfroLID sur la part v0 lors du prochain build.
