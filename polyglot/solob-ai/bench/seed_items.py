"""Génère le jeu d'items BROUILLON (author=machine-draft, status=draft) dans bench/items/*.jsonl.
Contenu rédigé pour ce benchmark : aucune question d'examen reprise. Les items en langues nationales
ne contiennent AUCUN texte inventé : ce sont des emplacements « à traduire par un locuteur natif »."""
import json, pathlib, sys

OUT = pathlib.Path(__file__).parent / "items"
SRC = "SOLOB bench v0-draft : rédigé pour ce benchmark (aucun examen ni manuel repris)"
CUR = "À RENSEIGNER par un enseignant (aucune référence officielle vérifiée)"
PREFIX = {"comprehension_linguistique": "ling", "connaissances_scolaires": "know", "mathematiques": "math", "sciences": "sci",
          "comprehension_curriculum": "curr", "qualite_explication": "expl", "fidelite_source": "faith", "hallucinations": "hall"}
NATIVE = {"fon": "BJ", "yo": "NG", "ha": "NG", "ig": "NG", "wo": "SN", "sw": "TZ"}
items, cnt = [], {}

def add(track, lang, country, level, q, ref, **kw):
    k = (track, lang); cnt[k] = cnt.get(k, 0) + 1
    it = {"item_id": f"{PREFIX[track]}-{lang}-{cnt[k]:04d}", "track": track, "language": lang, "country": country, "level": level,
          "curriculum_ref": CUR, "question": q, "reference": ref, "accepted": kw.pop("accepted", []),
          "source": SRC, "license": "CC-BY-4.0", "author": "machine-draft", "status": "draft", "reviewer_ids": [],
          "needs_native_speaker": False}
    it.update(kw); items.append(it); return it

T = "comprehension_linguistique"
add(T, "fr", "BJ", "primaire", "Texte : « Aïcha a acheté trois mangues au marché, puis elle en a donné une à son frère. » Combien de mangues reste-t-il à Aïcha ?", "deux", accepted=["2", "2 mangues", "deux mangues"])
add(T, "fr", "SN", "primaire", "Texte : « Le maître est arrivé en retard car la pluie avait inondé la route. » Pourquoi le maître est-il arrivé en retard ?", "la pluie avait inondé la route", accepted=["à cause de la pluie", "parce que la pluie avait inondé la route", "la route était inondée", "car la pluie avait inondé la route"])
add(T, "fr", "XX", "primaire", "Donne un synonyme de « rapide » parmi ces mots : lent, vif, lourd.", "vif")
add(T, "fr", "XX", "primaire", "Quel est le contraire du verbe « ouvrir » ?", "fermer")
add(T, "fr", "XX", "primaire", "Dans la phrase « Les enfants jouent dans la cour », quel est le verbe conjugué ?", "jouent")
add(T, "fr", "XX", "primaire", "Mets au pluriel : « un cheval ».", "des chevaux", accepted=["chevaux"])
add(T, "en", "GH", "primary", "Text: 'Kofi closed the window because it was cold.' Why did Kofi close the window?", "because it was cold", accepted=["it was cold", "the cold", "because of the cold"])
add(T, "en", "XX", "primary", "What is the plural of the word 'child'?", "children")
add(T, "en", "XX", "primary", "In the sentence 'The girl reads a book', what is the subject?", "the girl", accepted=["girl"])

T = "connaissances_scolaires"
add(T, "fr", "BJ", "primaire", "Quelle est la capitale officielle du Bénin ?", "Porto-Novo", accepted=["porto novo"])
add(T, "fr", "SN", "primaire", "Quelle est la capitale du Sénégal ?", "Dakar")
add(T, "fr", "NE", "primaire", "Quel fleuve traverse la ville de Niamey ?", "le Niger", accepted=["niger", "le fleuve niger"])
add(T, "fr", "BJ", "primaire", "Quel océan borde la côte du Bénin ?", "l'océan Atlantique", accepted=["atlantique", "océan atlantique"])
add(T, "fr", "BJ", "college", "En quelle année le Dahomey (actuel Bénin) est-il devenu indépendant ?", "1960")
add(T, "fr", "SN", "primaire", "Quelle est la langue officielle du Sénégal ?", "le français", accepted=["français"])
add(T, "en", "GH", "primary", "What is the capital city of Ghana?", "Accra")
add(T, "en", "NG", "junior_secondary", "In which year did Nigeria become independent?", "1960")
add(T, "en", "NG", "primary", "Which river is the name of Nigeria derived from?", "the Niger", accepted=["niger", "the niger river", "niger river"])

T = "mathematiques"
add(T, "fr", "BJ", "college", "Calcule 3/4 + 1/2. Donne le résultat sous forme décimale.", 1.25, tolerance=1e-6, accepted=["5/4"])
add(T, "fr", "BJ", "primaire", "Combien font 15 % de 2 000 F CFA ? (réponse en F CFA)", 300, tolerance=0.01)
add(T, "fr", "SN", "primaire", "Quelle est l'aire, en m², d'un rectangle de 7 m de long et 4 m de large ?", 28, tolerance=0.01)
add(T, "fr", "XX", "primaire", "Quel est le périmètre, en cm, d'un carré de 5 cm de côté ?", 20, tolerance=0.01)
add(T, "fr", "XX", "college", "Résous l'équation 2x + 3 = 11. Donne la valeur de x.", 4, tolerance=1e-6)
add(T, "fr", "XX", "primaire", "Quelle est la moyenne des notes 12, 15 et 9 ?", 12, tolerance=0.01)
add(T, "en", "NG", "primary", "What is 0.5 multiplied by 18?", 9, tolerance=1e-6)
add(T, "en", "GH", "primary", "A bus leaves at 8:15 and arrives at 10:45 the same morning. How many minutes does the trip take?", 150, tolerance=0.01)
add(T, "en", "XX", "junior_secondary", "What is the square root of 144?", 12, tolerance=1e-6)

T = "sciences"
add(T, "fr", "SN", "lycee", "Quelle est l'unité SI de la force ?", "le newton", accepted=["newton", "N"])
add(T, "fr", "XX", "college", "Quelle est la formule chimique de l'eau ?", "H2O", accepted=["h₂o"])
add(T, "fr", "XX", "primaire", "Quel organe pompe le sang dans le corps humain ?", "le cœur", accepted=["coeur", "cœur"])
add(T, "fr", "XX", "college", "À quelle température, en °C, l'eau pure bout-elle à la pression atmosphérique normale ?", 100, tolerance=0.5)
add(T, "fr", "XX", "college", "Quel gaz les plantes absorbent-elles pour réaliser la photosynthèse ?", "le dioxyde de carbone", accepted=["dioxyde de carbone", "co2", "gaz carbonique", "le gaz carbonique"])
add(T, "fr", "XX", "college", "Un véhicule parcourt 120 km en 2 heures. Quelle est sa vitesse moyenne en km/h ?", 60, tolerance=0.01)
add(T, "en", "XX", "primary", "Which planet is closest to the Sun?", "Mercury")
add(T, "en", "XX", "primary", "At what temperature, in °C, does pure water freeze at normal atmospheric pressure?", 0, tolerance=0.5)
add(T, "en", "XX", "junior_secondary", "What is the most abundant gas in Earth's atmosphere?", "nitrogen", accepted=["nitrogen gas", "n2"])

T = "comprehension_curriculum"
NOTE = "Fait sur le système scolaire : à confirmer par un enseignant du pays avant validation."
add(T, "fr", "BJ", "primaire", "Au Bénin, quelle classe suit directement le CM2 ?", "la sixième", accepted=["sixième", "6e", "6ème", "la 6e"], notes=NOTE)
add(T, "fr", "BJ", "primaire", "Au Bénin, combien d'années dure l'enseignement primaire, du CI au CM2 ?", "6", accepted=["six", "6 ans", "six ans"], notes=NOTE)
add(T, "fr", "BJ", "primaire", "Quel examen sanctionne la fin du cycle primaire au Bénin ? (sigle)", "CEP", accepted=["le cep", "certificat d'études primaires"], notes=NOTE)
add(T, "fr", "SN", "primaire", "Au Sénégal, quel examen sanctionne la fin de l'école élémentaire ? (sigle)", "CFEE", accepted=["le cfee", "certificat de fin d'études élémentaires"], notes=NOTE)
add(T, "fr", "BJ", "lycee", "Quel examen sanctionne la fin des études secondaires au Bénin ?", "le baccalauréat", accepted=["baccalauréat", "bac", "le bac"], notes=NOTE)
add(T, "fr", "SN", "lycee", "Au lycée, quelle classe précède la terminale ?", "la première", accepted=["première", "1re", "1ère"], notes=NOTE)
add(T, "en", "NG", "primary", "In Nigeria's 6-3-3-4 education system, how many years does primary school last?", "6", accepted=["six", "6 years", "six years"], notes=NOTE)
add(T, "en", "NG", "junior_secondary", "Which certificate examination is taken at the end of junior secondary school in Nigeria? (acronym)", "BECE", accepted=["basic education certificate examination"], notes=NOTE)
add(T, "en", "NG", "senior_secondary", "Which WAEC examination do students take at the end of senior secondary school? (acronym)", "WASSCE", accepted=["west african senior school certificate examination", "ssce"], notes=NOTE)

T = "qualite_explication"
H = {"criterion": "Langage adapté au niveau, sans erreur scientifique", "human_only": True, "points": 2}
add(T, "fr", "BJ", "primaire", "Explique à un élève de CM2 pourquoi il y a des jours et des nuits.",
    "La Terre tourne sur elle-même en environ 24 heures. Le Soleil n'éclaire qu'une moitié de la Terre à la fois : là où il éclaire, c'est le jour ; de l'autre côté, c'est la nuit.",
    rubric=[{"criterion": "Mentionne la rotation de la Terre sur elle-même", "keywords": ["tourne sur elle-même", "rotation", "tourne"], "points": 2},
            {"criterion": "Une seule moitié est éclairée par le Soleil", "keywords": ["moitié", "côté", "face"], "points": 2},
            {"criterion": "Ordre de grandeur de 24 heures", "keywords": ["24"], "points": 1}, H])
add(T, "fr", "XX", "college", "Explique pourquoi 1/2 + 1/3 n'est pas égal à 2/5.",
    "On ne peut additionner les numérateurs que si les dénominateurs sont égaux. On met au même dénominateur 6 : 1/2 = 3/6 et 1/3 = 2/6, donc la somme vaut 5/6, pas 2/5.",
    rubric=[{"criterion": "Notion de dénominateur commun", "keywords": ["dénominateur commun", "même dénominateur"], "points": 2},
            {"criterion": "Conversion correcte en sixièmes", "keywords": ["3/6", "2/6", "sixième"], "points": 1},
            {"criterion": "Résultat correct 5/6", "keywords": ["5/6"], "points": 2}, H])
add(T, "fr", "XX", "college", "Explique simplement la photosynthèse à un élève de collège.",
    "Grâce à la lumière du Soleil, la plante fabrique sa matière (des sucres) à partir de l'eau puisée par les racines et du dioxyde de carbone de l'air. Elle rejette du dioxygène.",
    rubric=[{"criterion": "Rôle de la lumière", "keywords": ["lumière", "soleil"], "points": 1},
            {"criterion": "Entrées : eau et dioxyde de carbone", "keywords": ["dioxyde de carbone", "co2", "gaz carbonique"], "points": 2},
            {"criterion": "Sorties : sucres et dioxygène", "keywords": ["oxygène", "dioxygène", "sucre", "glucose"], "points": 2}, H])
add(T, "fr", "BJ", "primaire", "Explique pourquoi il faut faire bouillir ou traiter l'eau non potable avant de la boire.",
    "L'eau non potable peut contenir des microbes (bactéries, parasites) qui provoquent des maladies comme la diarrhée ou le choléra. Les faire bouillir ou traiter l'eau les tue.",
    rubric=[{"criterion": "Présence de microbes", "keywords": ["microbe", "bactérie", "parasite", "germe"], "points": 2},
            {"criterion": "Lien avec des maladies", "keywords": ["maladie", "diarrhée", "choléra", "typhoïde"], "points": 2},
            {"criterion": "Effet du traitement (tuer les microbes)", "keywords": ["tue", "détruit", "élimine"], "points": 1}, H])
add(T, "fr", "XX", "college", "Explique la différence entre la masse et le poids.",
    "La masse est la quantité de matière, en kilogrammes, et ne change pas selon le lieu. Le poids est la force exercée par la pesanteur, en newtons ; il dépend du lieu (il est plus faible sur la Lune).",
    rubric=[{"criterion": "Masse en kilogrammes, invariable", "keywords": ["kilogramme", "kg"], "points": 2},
            {"criterion": "Poids = force, en newtons", "keywords": ["newton", "force"], "points": 2},
            {"criterion": "Le poids dépend du lieu / de la gravité", "keywords": ["gravité", "pesanteur", "lune", "lieu"], "points": 1}, H])
add(T, "en", "XX", "junior_secondary", "Explain to a 12-year-old why the Moon seems to change shape during the month.",
    "The Moon does not make its own light; the Sun always lights half of it. As the Moon orbits the Earth, we see different amounts of that lit half, which gives the phases.",
    rubric=[{"criterion": "The Moon is lit by the Sun", "keywords": ["sun", "sunlight", "reflect"], "points": 2},
            {"criterion": "Half of the Moon is always lit", "keywords": ["half"], "points": 1},
            {"criterion": "Orbit around the Earth changes what we see", "keywords": ["orbit", "goes around", "moves around"], "points": 2}, H])
add(T, "en", "XX", "junior_secondary", "Explain why dividing by a fraction is the same as multiplying by its reciprocal.",
    "Dividing by a number asks how many times it fits. Dividing by 1/2 asks how many halves fit, which is twice as many, so it equals multiplying by 2, the reciprocal of 1/2.",
    rubric=[{"criterion": "Uses the word reciprocal or inverse", "keywords": ["reciprocal", "inverse", "flip"], "points": 2},
            {"criterion": "Gives a concrete example", "keywords": ["1/2", "half", "halves"], "points": 2},
            {"criterion": "Links division to 'how many fit'", "keywords": ["how many", "fit"], "points": 1}, H])

T = "fidelite_source"
FMT_FR = "Réponds en t'appuyant uniquement sur le texte, puis recopie la phrase justificative au format [citation: \"...\"]."
FMT_EN = "Answer using only the text, then copy the supporting sentence in the format [citation: \"...\"]."
add(T, "fr", "BJ", "primaire", "D'après le texte, comment les habitants de ce village se déplacent-ils ?", "en pirogue", accepted=["pirogue"],
    passage="Ganvié est une cité lacustre construite sur le lac Nokoué. Ses habitants pratiquent la pêche et se déplacent en pirogue.", instruction=FMT_FR)
add(T, "fr", "XX", "primaire", "D'après le texte, quel jour la cantine sert-elle du riz ?", "le mardi", accepted=["mardi"],
    passage="Dans ce village imaginaire, l'école ouvre à 7 h 30. La cantine sert du riz le mardi et des haricots le jeudi.", instruction=FMT_FR,
    notes="Passage fictif : teste la fidélité au texte plutôt qu'aux connaissances du modèle.")
add(T, "fr", "XX", "primaire", "Selon le texte, qu'est-ce qui aide le baobab à survivre pendant la saison sèche ?", "il stocke de l'eau dans son tronc",
    accepted=["stocker de l'eau dans son tronc", "l'eau stockée dans son tronc", "stocker de grandes quantités d'eau dans son tronc"],
    passage="Le baobab peut stocker de grandes quantités d'eau dans son tronc. Cette réserve l'aide à survivre pendant la saison sèche.", instruction=FMT_FR)
add(T, "fr", "XX", "primaire", "D'après l'histoire, combien de chèvres Koffi vend-il ?", "cinq", accepted=["5", "cinq chèvres", "5 chèvres"],
    passage="Dans cette histoire, Koffi possède douze chèvres. Le samedi, il en vend cinq au marché pour payer l'école de sa fille.", instruction=FMT_FR)
add(T, "en", "XX", "primary", "According to the text, what is grown in the third bed?", "okra",
    passage="The school garden has three beds. The first bed is for tomatoes, the second for onions and the third for okra.", instruction=FMT_EN)
add(T, "en", "XX", "primary", "According to the text, why did the market move to the hill?", "the river flooded", accepted=["because the river flooded", "the river flooded in august"],
    passage="In this story, the river flooded in August. Because of the flood, the market moved to the hill.", instruction=FMT_EN,
    notes="Passage fictif.")

T = "hallucinations"
add(T, "fr", "BJ", "college", "Quel président du Bénin a été le premier à marcher sur la Lune ?", None, expected_behavior="abstain", notes="Prémisse fausse : aucun président béninois n'est allé sur la Lune.")
add(T, "fr", "XX", "primaire", "Quelle est la capitale de la Zorbanie ?", None, expected_behavior="abstain", notes="Pays inventé.")
add(T, "fr", "XX", "primaire", "Pourquoi le Soleil se lève-t-il à l'ouest ?", "se lève à l'est", accepted=["se lève à l est", "à l'est"], expected_behavior="correct_premise")
add(T, "fr", "XX", "primaire", "Texte : « Amina est allée à l'école à pied. » D'après le texte, de quelle couleur est la voiture d'Amina ?", None, expected_behavior="abstain", notes="Information absente du texte.")
add(T, "fr", "BJ", "college", "En quelle année Cotonou a-t-elle accueilli les Jeux olympiques d'été ?", None, expected_behavior="abstain", notes="Prémisse fausse.")
add(T, "fr", "XX", "primaire", "Combien font 7 × 8 ?", "56", expected_behavior="answer", notes="Item témoin : pénalise l'abstention systématique.")
add(T, "en", "NG", "junior_secondary", "In which year did the Niger River freeze over completely?", None, expected_behavior="abstain", notes="False premise.")
add(T, "en", "XX", "primary", "Why is 2 + 2 equal to 5?", "equals 4", accepted=["is 4", "equal to 4", "makes 4"], expected_behavior="correct_premise")
add(T, "en", "GH", "primary", "What is the capital city of Ghana?", "Accra", expected_behavior="answer", notes="Control item.")

# Emplacements à traduire : 2 items FR par piste x 6 langues. Aucun texte inventé.
seen = {}
for it in list(items):
    if it["language"] != "fr": continue
    seen[it["track"]] = seen.get(it["track"], 0) + 1
    if seen[it["track"]] > 2: continue
    for lang, ctry in NATIVE.items():
        k = (it["track"], lang); cnt[k] = cnt.get(k, 0) + 1
        items.append({"item_id": f"{PREFIX[it['track']]}-{lang}-{cnt[k]:04d}", "track": it["track"], "language": lang, "country": ctry,
                      "level": it["level"], "curriculum_ref": CUR, "question": None, "reference": None, "accepted": [],
                      "source": SRC, "license": "CC-BY-4.0", "author": "machine-draft", "status": "draft", "reviewer_ids": [],
                      "needs_native_speaker": True, "translate_from": it["item_id"],
                      "notes": "À TRADUIRE ET ADAPTER par un locuteur natif enseignant (question, réponse, variantes, passage)."})

if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from solob_ai.bench.schema import validate
    bad = {i["item_id"]: validate(i) for i in items if validate(i)}
    if bad: raise SystemExit(json.dumps(bad, ensure_ascii=False, indent=1))
    OUT.mkdir(exist_ok=True)
    by = {}
    for i in items: by.setdefault(i["track"], []).append(i)
    for t, lst in by.items():
        with open(OUT / f"{t}.jsonl", "w", encoding="utf-8") as f:
            for i in lst: f.write(json.dumps(i, ensure_ascii=False) + "\n")
    print(len(items), "items écrits")
