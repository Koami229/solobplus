# Mission 3 — Sources candidates (étape 2 : recherche uniquement, AUCUNE collecte)

Vérification le 2026-10-31 (UTC+1) : code HTTP via curl, licences lues depuis l'API GitHub (`license.spdx_id`), les tags/cardData de l'API Hugging Face, ou le fichier LICENSE. « needs-check » = licence non établie de façon suffisante → quarantaine, aucune entrée dans l'entraînement. Tailles : déclarées par les auteurs, non mesurées.

Politique : liste blanche CC0 / CC BY / CC BY-SA / domaine public / ODC-BY / Apache/MIT pour les données. NC (non commercial) = rejet pour l'entraînement (SOLOB+ a un volet Business), éventuellement utilisable en éval interne de recherche seulement si Koami l'accepte explicitement.

| # | Source | URL (HTTP) | Langues (cible) | Taille (déclarée) | Licence | Preuve | Restrictions | Pertinence éducative | Risque | Reco |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | FLORES+ (openlanguagedata) | https://huggingface.co/datasets/openlanguagedata/flores_plus (200, gated auto) | fon, fr, en, yo, ha, wo, sw, ig, + ~200 | ~2 000 phrases/langue | CC BY-SA 4.0 | tag HF `license:cc-by-sa-4.0` | attribution + partage identique ; accès conditionné (acceptation des termes) | faible (Wikinews/Wikivoyage) — idéal pour **éval** traduction/langue | contamination si utilisé en train | **approve** (éval uniquement) |
| 2 | Google SMOL | https://huggingface.co/datasets/google/smol (200) | inclut fon (vérifié dans tags) + nombreuses langues africaines | petit (phrases/docs traduits) | CC BY 4.0 | tag HF + cardData `cc-by-4.0` | attribution | moyenne (phrases générales) | faible | **approve** |
| 3 | MADLAD-400 | https://huggingface.co/datasets/allenai/MADLAD-400 (200) | multilingue (dont yo, ha, sw, ig, wo ; fon à vérifier) | très grand (CommonCrawl) | ODC-BY (sur l'emballage) | tag HF `license:odc-by` | ODC-BY couvre la compilation, **pas** les droits des pages web sous-jacentes ; bruit élevé | faible | droits sous-jacents incertains, texte web bruité/généré | **needs-check** |
| 4 | AfriBERTa corpus | https://huggingface.co/datasets/castorini/afriberta-corpus (200) | ha, ig, sw, yo, pcm, … (pas fon/wo) | ~1 Go total | Apache-2.0 (tag) | tag HF `license:apache-2.0` | idem : textes de presse (BBC…) dont les droits d'origine ne sont pas cédés | faible | droits sous-jacents | **needs-check** |
| 5 | MasakhaNER 2.0 | https://huggingface.co/datasets/masakhane/masakhaner2 (200) | fon, yo, ha, ig, sw, wo, … | ~5k phrases/langue | AFL-3.0 | tag HF `license:afl-3.0` | annotations libres ; textes de presse | faible (NER) — utile éval linguistique | droits sous-jacents presse | **needs-check** (éval possible) |
| 6 | MasakhaNER 1 (repo) | https://github.com/masakhane-io/masakhane-ner (200) | yo, ha, ig, sw, wo, … | ~ | NOASSERTION (README : code Apache-2) | API GitHub | licence données non explicite | faible | non établie | **needs-check** |
| 7 | MAFAND-MT | https://huggingface.co/datasets/masakhane/mafand (200) ; repo lafand-mt GPL-3.0 (code) | fon-fr, yo/ha/ig/sw/wo-en … | ~5k phrases/paire | **CC BY-NC 4.0** | tag HF | non commercial | faible-moyenne (traduction) | NC | **reject** (train) ; éval interne seulement si accord |
| 8 | MasakhaNEWS | https://huggingface.co/datasets/masakhane/masakhanews (200) | ha, ig, sw, yo, fr, en … (pas fon) | ~ milliers d'articles | AFL-3.0 | tag HF | presse | faible | droits sous-jacents | **needs-check** |
| 9 | AfriSenti | https://huggingface.co/datasets/masakhane/afrisenti (200) | ha, ig, sw, yo, … | ~110k tweets | **CC BY-NC-SA 2.0** | tag HF | NC + tweets (CGU X) | nulle | NC, données personnelles | **reject** |
| 10 | FFR Fon-French (Dossou & Emezue) | https://github.com/bonaventuredossou/ffr-v1 (200) | fon-fr | ~117k paires | **CC BY-NC-SA 4.0** + accord des auteurs obligatoire | LICENSE.md du dépôt | non commercial ; demande d'autorisation aux auteurs exigée | moyenne (dialogues, vocabulaire) | NC + permission | **reject** tant que pas d'accord écrit des auteurs (piste : leur écrire) |
| 11 | AfroLID (UBC-NLP) | https://github.com/UBC-NLP/AfroLID (200) | 517 langues dont fon | modèle d'identification de langue | Apache-2.0 (code) | API GitHub | — | outil (qualité : identification de langue), pas corpus | faible | **approve** (outil qualité) |
| 12 | Sahara / AfroLingu (UBC-NLP) | https://huggingface.co/datasets/UBC-NLP/sahara (401 — gated/privé) | multi | ? | non lisible | — | inaccessible sans compte | ? | inconnu | **needs-check** |
| 13 | OPUS (portail) | https://opus.nlpl.eu/ (200) | fon, yo, ha, … selon sous-corpus | variable | **par sous-corpus** (Tatoeba CC BY 2.0 FR, GNOME/Ubuntu GPL/LGPL, …) | à vérifier un par un | variable | variable | mélange de licences | **needs-check** par sous-corpus (Tatoeba : candidat approve) |
| 14 | JW300 | https://opus.nlpl.eu/JW300.php (**404, retiré**) | fon, yo, ha, … | ~100k phrases/langue | retiré : CGU jw.org interdisent la réutilisation | page retirée d'OPUS | droits non accordés | faible (religieux) | **juridique élevé** | **reject** |
| 15 | Bibles (eBible.org) | https://ebible.org/ (200) | fon, yo, ha, … selon traduction | ~30k versets/langue | **par traduction** (certaines CC BY-SA/PD, beaucoup © sociétés bibliques) | page « copyright » de chaque traduction | variable | faible (religieux, biais de registre) | biais + licences | **needs-check** par traduction ; ne garder que PD/CC BY(-SA) |
| 16 | Mozilla Common Voice | https://commonvoice.mozilla.org/ (200) | ha, sw, yo, ig, wo, tw, ee, zu, xh (**pas de fon** — API langues) | phrases de quelques k à 100k+ | CC0 (phrases et audio) | CGU Common Voice | téléchargement via compte/accept. | faible (phrases courtes) | faible | **approve** (sauf fon : absent) — à confirmer à la collecte |
| 17 | Lacuna Fund | https://lacunafund.org/datasets/ (200) | variable (agri, santé, langue) | variable | **par dataset** | fiche de chaque dataset | variable | variable | variable | **needs-check** dataset par dataset |
| 18 | African Storybook | https://www.africanstorybook.org/ (curl : timeout ; site bloque/lent) ; texte : https://github.com/global-asp/asp-raw-db | ~200 langues africaines dont yo, ha, sw, ig, wo… (fon à vérifier) | milliers d'histoires | **CC BY ou CC BY-NC selon l'histoire** (métadonnée par fichier) | README asp-raw-db + métadonnée par histoire | ne garder que CC BY | **élevée** (lecture primaire) | mélange BY/NC → filtre strict | **approve** (filtre CC BY uniquement, par histoire) |
| 19 | Global Digital Library | https://digitallibrary.io/ (200) | multi (dont langues africaines) | milliers de livres | majoritairement CC BY (par livre) — non vérifié livre par livre | fiche par livre | par livre | **élevée** | mélange | **needs-check** (probable approve avec filtre) |
| 20 | Siyavula (Afrique du Sud) | https://www.siyavula.com/ (200) | en (+ af) | manuels maths/sciences gr. 4-12 | CC BY (éditions récentes) ; certaines éditions CC BY-ND — à vérifier par manuel | mention dans chaque manuel | ND interdit les dérivés | **très élevée** (maths/sciences) | ND sur certaines éditions | **needs-check** (approve si CC BY confirmé) |
| 21 | KICD (Kenya) | https://kicd.ac.ke/ (200) | en, sw | programmes, manuels | © KICD (pas de licence ouverte trouvée) | — | tous droits réservés | élevée | droits | **reject** sauf ressource explicitement ouverte |
| 22 | OER Africa | https://www.oerafrica.org/ (**403** à curl) | en, fr | ressources formation enseignants | par ressource (souvent CC BY / BY-SA / BY-NC) | à vérifier | variable | élevée | variable, site non vérifié | **needs-check** |
| 23 | Wikibooks / Wikisource (fr, en, yo…) | https://fr.wikibooks.org/ , https://fr.wikisource.org/ (200) | fr, en (+ peu de langues africaines) | grand | Wikibooks CC BY-SA 4.0 ; Wikisource : PD majoritaire (mais œuvres anciennes) | pied de page MediaWiki (rightsinfo) | BY-SA | Wikibooks **moyenne-élevée** (cours) | faible | **approve** (Wikibooks) ; Wikisource needs-check par œuvre |
| 24 | UNESCO OER | https://en.unesco.org/themes/building-knowledge-societies/oer (200) | multi | portail, pas un corpus | par ressource | — | variable | moyenne | variable | **needs-check** (portail) |
| 25 | Ressources ministères (Bénin, Togo, Sénégal, CI, Ghana, Nigeria) | non vérifiées | fr, en, langues nationales | ? | aucune licence ouverte identifiée | — | présumé © | élevée | droits | **needs-check** — contacter les ministères |

## Recommandés à approuver (collecte après ton feu vert)
1. African Storybook — uniquement les histoires CC BY (filtre par métadonnée).
2. Google SMOL (CC BY 4.0, contient du fon).
3. FLORES+ (CC BY-SA 4.0) — **évaluation uniquement**, jamais en entraînement.
4. Common Voice (CC0) — phrases texte, langues hors fon.
5. Wikibooks fr/en (CC BY-SA 4.0).
6. AfroLID (Apache-2.0) — outil d'identification de langue pour le pipeline qualité.

## Rejetés
- JW300 : retiré d'OPUS (404), CGU jw.org.
- FFR : CC BY-NC-SA + accord obligatoire des auteurs (reconsidérable si accord écrit).
- MAFAND-MT : CC BY-NC 4.0.
- AfriSenti : CC BY-NC-SA + tweets.
- KICD : tous droits réservés.

## Fon — disponibilité honnête
Ouvert et utilisable pour l'entraînement : Wikipedia fon (0,5 Mo, déjà intégralement utilisé en v0), SMOL (petit), quelques histoires African Storybook si CC BY (à vérifier). FLORES+ fon : ~2 000 phrases, éval seulement. Les gros corpus fon (FFR ~117k paires, MAFAND, JW300) sont NC ou non autorisés. Common Voice n'a pas de fon. Conclusion : le corpus fon ouvert restera de l'ordre du mégaoctet ; un vrai saut exige des partenariats (auteurs FFR, enseignants, ministère béninois) avec licence écrite.
