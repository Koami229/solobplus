# SAKC v1 — provenance et licences (Mission 3, étape 3)

Construit le 2026-10-31 (UTC+1) par `python -m solob_ai.sakc.build_v1` (8 min 10 s, CPU). Sortie locale, non versionnée : `data/sakc/v1/` (train/val/test.jsonl, educational.jsonl, MANIFEST.json, BUILD_REPORT.json, trace.jsonl). v0 lu en lecture seule et inchangé : 0 document v0 perdu, 0 changé de split (vérifié). Chaque document porte `license`, `rights_status`, `proof_ref` et une URL vers sa source.
Pipeline identique à v0 : nettoyage NFC → QC (≥200 caractères, ratio de lettres, lignes répétées) → doublons exacts + MinHash (0,8) → porte des droits → split déterministe par SHA-256. Ajout v1 : identification de langue AfroLID sur les nouveaux documents africains.
Les tailles sont en **caractères** (len Python), mesurées sur les documents acceptés.

## Sources
| source | licence | preuve | collecté | accepté (docs) | exclus et raisons |
|---|---|---|---|---|---|
| Wikipedia (v0) | CC BY-SA 4.0 | `data/raw/wikipedia/<lang>.proof.json` | v0 | 5 314 (= v0) | — |
| African Storybook (miroir texte `global-asp/asp-raw-db` @096a27f) | CC BY 4.0 / CC BY 3.0, **par histoire** (champ `lic:`) | `asb/proof.json` + `asb/repo/data/<id>.txt#lic` | 3 571 histoires dans les 8 langues | 3 137 | 8 141 hors langues cibles ; **153 NC** (bloquées par la porte des droits) ; 18 langue incorrecte selon AfroLID (ig 4, sw 6, ha 7, yo 1) ; le reste trop court (<200 car.) ou doublons |
| Google SMOL (rév. fdaff3a) | CC BY 4.0 | `smol/proof.json` (tag HF + README, SHA-256 des fichiers) | côtés non anglais de smoldoc + smolsent (fon, yo, ha, wo, sw, ig) | 3 277 | côté anglais écarté volontairement (texte source, souvent synthétique) ; phrases groupées par ~1 500 car. |
| Common Voice (commit 48982e4) | CC0 1.0 | `commonvoice/proof.json` (LICENSE + SHA-256) | phrases texte uniquement, aucun audio ; ha, ig, sw, yo + fr/en (sentence-collector) | 6 596 | plafond 3 M car./langue : 28 234 phrases fr et 50 933 sw non retenues ; **pas de fon ni de wo** dans Common Voice |
| Wikibooks fr/en (dumps 20261001, SHA-1 vérifiés) | CC BY-SA 4.0 | `wikibooks/proof.json` (API rightsinfo) | pages ns0 non-redirection, ordre du dump | 5 276 (fr 2 773, en 2 503) | plafond 15 M car./langue atteint (21 519 pages fr et 87 884 en non lues) ; 552 pages < 200 car. |
| FLORES+ | CC BY-SA 4.0 | `flores/proof.json` | **BLOQUÉ** : jeu à accès conditionné (401 sans compte HF ayant accepté les conditions) | 0 | non collecté ; contrôle de fuite implémenté (`EVAL_ONLY_SOURCES`) : 0 |
| AfroLID 1.5 (`UBC-NLP/afrolid_1.5`, rév. 34d2292) | Apache-2.0 (dépôt GitHub ; la fiche HF n'a pas de tag licence) | — | outil, poids dans `artifacts/afrolid/` (1,1 Go) | n/a | ne couvre pas fr/en → appliqué uniquement aux langues africaines |

Totaux pipeline : 153 bloqués droits, 95 doublons exacts, 50 quasi-doublons, 494 trop courts, 88 ratio de lettres faible, 25 lignes répétées, 18 langid.

## Caractères par langue (v0 → v1)
| langue | v0 | v1 | ×  | dont sous-ensemble éducatif |
|---|---|---|---|---|
| fr | 1 933 126 | 20 100 307 | 10,4 | 15 111 428 |
| en | 1 988 137 | 22 665 160 | 11,4 | 17 895 408 |
| **fon** | **424 127** | **653 811** | **1,54** | **1 747 (1 histoire)** |
| yo | 1 555 375 | 2 679 994 | 1,72 | 28 615 |
| ha | 1 979 555 | 3 176 855 | 1,60 | 131 241 |
| wo | 1 631 773 | 2 067 667 | 1,27 | 0 |
| sw | 1 987 637 | 6 507 044 | 3,27 | 643 082 |
| ig | 1 726 146 | 2 968 254 | 1,72 | 13 573 |
| total | 13 225 876 | 60 819 092 | 4,6 | 33 825 094 |

fon v1 = Wikipedia 424 127 + SMOL 227 937 + African Storybook 1 747.
Splits v1 : train 21 359 / val 1 156 / test 1 085 docs. Éducatif = African Storybook + Wikibooks (train 7 625 / val 402 / test 386), `educational.jsonl`.

## Limites honnêtes
- Le corpus éducatif est dominé par fr/en (Wikibooks) ; en langues africaines il se limite à des histoires de lecture de niveau primaire.
- Wikibooks : premières pages du dump jusqu'au plafond, pas une sélection par matière ; discipline/niveau = `inconnu`. Contenu non relu.
- Common Voice : phrases courtes isolées ; une partie (wiki.sw, wiki.ig) vient de Wikipedia → recouvrement partiel avec v0.
- SMOL : traductions humaines de textes anglais (registre de traduction).
- AfroLID n'est qu'un filtre automatique ; non vérifié par des locuteurs.
- Dépendances ajoutées au venv (pas au lock hashé) : mwparserfromhell, transformers 4.46.3.
