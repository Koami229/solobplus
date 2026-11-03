# SOLOB Educational Benchmark (brouillon v0-draft)

> **Statut : BROUILLON.** Les 163 items ont tous `author=machine-draft` et `status=draft`. Aucun n'est validé par un
> enseignant. **Tout score obtenu sur cette version est NON PUBLIABLE.**

## 1. Objectif

Le benchmark mesure si un modèle (SOLOB AI v0, le futur `solob-local` ou tout autre fournisseur) est utile en contexte
scolaire en Afrique de l'Ouest et de l'Est. Il couvre le français, l'anglais et à terme les langues nationales (fon,
yoruba, haoussa, igbo, wolof, swahili). Il ne prétend pas être aligné sur un programme officiel tant que des enseignants ne
l'ont pas confirmé : le champ `curriculum_ref` vaut « À RENSEIGNER » partout.

## 2. Les huit pistes

| Piste | Fichier | Métrique | Détail |
|---|---|---|---|
| Compréhension linguistique | `comprehension_linguistique.jsonl` | exact match | Normalisation : NFC, minuscules, ponctuation et article initial retirés. **Les diacritiques sont conservés**, car les tons sont significatifs en fon et en yoruba. Une liste `accepted` donne les variantes admises. |
| Connaissances scolaires | `connaissances_scolaires.jsonl` | exact match | Géographie et histoire de base. |
| Mathématiques | `mathematiques.jsonl` | tolérance numérique | Premier nombre de la réponse (décimales avec `,` ou `.`, fractions `a/b`). Correct si `abs(v - ref) <= tolerance`. |
| Sciences | `sciences.jsonl` | exact match, ou numérique si `tolerance` est présent | |
| Compréhension du curriculum | `comprehension_curriculum.jsonl` | exact match | Faits sur les systèmes scolaires (classes, cycles, examens). **Chaque item doit être confirmé par un enseignant du pays.** |
| Qualité d'explication | `qualite_explication.jsonl` | rubrique | Critères pondérés. Le score automatique (mots-clés) n'est qu'un **proxy**. Le score publiable est la **note humaine** (fichier `--human-grades`). Les critères `human_only` (adéquation au niveau, absence d'erreur) ne sont jamais notés automatiquement. |
| Fidélité à la source | `fidelite_source.jsonl` | réponse correcte **et** citation vérifiée | La réponse doit contenir `[citation: "..."]`. La citation doit figurer mot pour mot dans le passage (8 caractères au minimum). Des passages fictifs testent la fidélité au texte plutôt qu'aux connaissances du modèle. |
| Hallucinations | `hallucinations.jsonl` | abstention ou correction | `expected_behavior` vaut `abstain` (question sans réponse : pays inventé, information absente), `correct_premise` (prémisse fausse, la correction attendue doit être mentionnée) ou `answer` (items témoins, qui pénalisent l'abstention systématique). La détection d'abstention repose sur une liste de formules fr/en. |

## 3. Schéma d'un item

Le schéma formel est dans `bench/schema.json` ; la validation stricte est faite par `solob_ai/bench/schema.py`.

* **Champs obligatoires :**
  * `item_id`, `track`, `language`, `country` (ISO, `XX` si non spécifique) ;
  * `level`, `curriculum_ref`, `question`, `reference` ;
  * `source`, `license` (liste blanche CC-BY-4.0, CC0-1.0, CC-BY-SA-4.0) ;
  * `author`, `status` (`draft` ou `validated`), `reviewer_ids`, `needs_native_speaker`.
* **Champs selon la piste :** `accepted`, `tolerance`, `rubric`, `passage`, `instruction`, `expected_behavior`,
  `translate_from`, `notes`.
* **Règles :**
  * `validated` exige au moins 2 `reviewer_ids` distincts.
  * Un item `needs_native_speaker=true` a `question=null` et `reference=null`, porte `translate_from`, et ne peut pas être
    validé tant qu'il n'est pas traduit.

## 4. Contenu actuel (graine)

Les items sont générés par `bench/seed_items.py`, de façon reproductible (un test le vérifie). Ils ont été rédigés pour ce
benchmark, sans reprendre aucun sujet d'examen ni manuel.

| Piste | fr | en | Emplacements à traduire (fon, yo, ha, ig, wo, sw × 2) |
|---|---:|---:|---:|
| Compréhension linguistique | 6 | 3 | 12 |
| Connaissances scolaires | 6 | 3 | 12 |
| Mathématiques | 6 | 3 | 12 |
| Sciences | 6 | 3 | 12 |
| Curriculum | 6 | 3 | 12 |
| Qualité d'explication | 5 | 2 | 12 |
| Fidélité à la source | 4 | 2 | 12 |
| Hallucinations | 6 | 3 | 12 |
| **Total** | **45** | **22** | **96** |

**Aucun texte n'a été rédigé en langue nationale.** Pour chaque piste, les deux premiers items français ont un emplacement
dans chacune des six langues. Cet emplacement doit être traduit **et adapté culturellement** par un enseignant locuteur
natif : question, réponse, variantes et passage. Pour le fon et le yoruba, le travail inclut l'orthographe tonale. Le
harnais ignore ces items et les compte à part (`items_non_traduits_ignores`).

**Licence :** les items sont prévus sous CC-BY-4.0. C'est **à confirmer par Koami**, qui est le détenteur des droits.

## 5. Validation par des experts

1. **Export vers la relecture.** `python -m solob_ai.bench.export to-review --out data/bench/review_items.jsonl`, puis
   `python -m solob_ai.review.cli import-items data/bench/review_items.jsonl` (migration 005).
   * Le type de relecture dépend de l'item : `question` pour la plupart des pistes, `explanation` pour la qualité
     d'explication, `translation` pour les emplacements à traduire.
   * Les identifiants prennent la forme `bench:<item_id>`.
2. **Relecteurs.** Il faut des enseignants habilités (`ai_reviewer_profiles`, accordé par un admin), de préférence du pays
   et de la langue de l'item.
3. **Double relecture en aveugle** sur `/review` : chaque relecteur décide `accept`, `needs_fix` ou `reject`.
   * Deux `accept` donnent `validated`.
   * Un désaccord donne `disputed`, à arbitrer par un troisième relecteur.
   * Un item `needs_fix` est corrigé dans `seed_items.py` (ou dans un fichier d'items humain), puis il repart en relecture
     sous un **nouvel** `item_id`.
4. **Contrôles par l'enseignant :**
   * exactitude de la réponse et complétude des variantes `accepted` ;
   * adéquation au niveau et au pays ;
   * `curriculum_ref` à renseigner ;
   * absence de biais ou de contenu sensible.
5. **Accord inter-relecteurs.** Le kappa de Cohen est calculé par type et par langue (`review.cli kappa`, ou la vue
   `ai_review_agreement`). Seuil visé avant publication : **κ ≥ 0,6** par piste et par langue publiée. Ce seuil est une
   proposition, à décider.
6. **Synchronisation.** `python -m solob_ai.bench.export sync-status` passe en `validated` les items validés en base, avec
   leurs `reviewer_ids`. Seuls les items ayant au moins 2 relecteurs `accept` distincts sont concernés.
7. **Notes humaines des explications.** Pour chaque sortie du modèle, deux enseignants appliquent la rubrique. Les notes
   sont normalisées entre 0 et 1, puis fournies au harnais par `--human-grades grades.jsonl`, au format
   `{"item_id", "score"}`. Le harnais fait la moyenne des notes d'un même item.

## 6. Protocole d'évaluation

* **Harnais :** `python -m solob_ai.bench.run --provider v0|command ...`.
  * Décodage glouton (déterministe).
  * Prompt « Question : … / Réponse : ».
  * Pour la piste fidélité, le passage et l'instruction de citation sont ajoutés au prompt.
* **Fournisseurs :**
  * `V0Checkpoint` : le prototype local.
  * `CommandProvider` : une commande locale lit le prompt sur stdin et écrit la réponse sur stdout. C'est l'interface
    prévue pour le futur `solob-local`.
  * Le harnais n'appelle aucun service réseau ni payant.
* **Sortie :** JSON contenant :
  * la description du fournisseur ;
  * l'empreinte `items_sha256` de l'ensemble d'items et de leurs statuts ;
  * les scores par piste et par langue, avec le nombre d'items `n` ;
  * le détail de chaque prédiction.

## 7. Règles de publication

Le harnais attribue le label `PUBLIABLE` **uniquement** si toutes les conditions suivantes sont réunies :

* chaque item évalué est `status=validated` avec au moins 2 relecteurs distincts ;
* si la piste explication est incluse, ses scores sont des notes humaines (`--human-grades`) ;
* aucun item rédigé par machine n'est resté sans double relecture.

Dans tous les autres cas, chaque résultat porte le label **« NON PUBLIABLE »** et la liste des raisons. Avec
`--publish`, le harnais **refuse de tourner** (code de sortie 2) si les conditions ne sont pas réunies.

Règles complémentaires, pour les humains :

* toujours publier `n` par piste et par langue ;
* ne jamais agréger une langue qui a moins de 30 items validés ;
* publier la version et l'empreinte des items, le fournisseur et le décodage ;
* ne pas comparer des scores obtenus sur des empreintes différentes ;
* garder un split de test privé avant toute publication large, pour limiter la contamination.

## 8. Test de fumée sur v0 (31/10/2026) — NON PUBLIABLE

Commande : `--provider v0 --ckpt artifacts/run_cpu_v0/last.pt --tokenizer artifacts/toklab/unigram_8000.model`.
Le modèle a environ 2,3 M de paramètres et 3 000 pas d'entraînement. Le run évalue 67 items en 3,1 s, ignore 96 items non
traduits, et produit l'empreinte `a0b5c28f…`.

**Score 0,0 sur les 8 pistes, en fr comme en en.** Les sorties sont des fragments de mise en page Wikipédia (par exemple
« Notes et références », « Liens externes »). Ce résultat est attendu pour un modèle de langage brut, minuscule et sans
ajustement aux instructions. Il montre seulement que le harnais fonctionne de bout en bout. **Il ne dit rien de la qualité
du benchmark** et ne constitue pas un résultat.

## 9. Limites connues

* 67 items rédigés ne suffisent pas à obtenir une mesure stable : l'intervalle de confiance est très large. Il en faut au
  moins plusieurs centaines par piste et par langue.
* L'exact match pénalise les réponses longues mais correctes. Une variante plus tolérante, ou un juge humain, sera à
  ajouter si besoin.
* La détection d'abstention et le proxy de rubrique reposent sur des mots-clés fr/en. Ils devront être étendus aux langues
  nationales par des locuteurs natifs.
* Les faits de la piste curriculum (CEP, CFEE, BECE, WASSCE, durée du primaire) correspondent à ma connaissance, mais n'ont
  **pas été vérifiés** auprès de sources officielles.
