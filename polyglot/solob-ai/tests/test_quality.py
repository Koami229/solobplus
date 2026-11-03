import hashlib
from solob_ai.sakc.quality import checks as C

def doc(text, **kw):
    d = {"source_id": "wikipedia-yo", "url": "https://yo.wikipedia.org/wiki/X", "license": "CC-BY-SA-4.0",
         "rights_status": "rights_verified", "proof_ref": "yo.proof.json", "language": "yo", "version": "v1",
         "country": "NG", "level": "general", "discipline": "general", "text": text,
         "sha256": hashlib.sha256(text.encode()).hexdigest()}
    d.update(kw); return d

def test_repetition_and_diversity():
    rep = "le chat mange la souris . " * 80
    assert "repetition_trigrammes" in C.repetition_flags(rep)
    assert C.lexical_diversity(rep) < 0.1
    varied = " ".join(f"mot{i}" for i in range(400))
    assert C.repetition_flags(varied) == [] and C.lexical_diversity(varied) == 1.0
    assert C.lexical_diversity("trop court") is None

def test_template_coverage():
    t = "a b c d e f g h"
    tpl = C.ngrams("a b c d e f", 6)
    assert abs(C.template_coverage(t, tpl) - 6 / 8) < 1e-9
    assert C.template_coverage(t, set()) == 0

def test_bot_patterns_only_wikipedia():
    assert "stub_court_wikipedia" in C.bot_pattern_flags("Ìlú kékeré.", "wikipedia-yo")
    assert C.bot_pattern_flags("court", "google-smol") == []

def test_yoruba_tones_and_fon_letters():
    assert "yo_sans_tons" in C.orthography_flags("Ilu nla ni Eko je ni orile ede Naijiria " * 10, "yo")
    assert not any(f.startswith("yo_sans_tons") for f in C.orthography_flags("Ìlú ńlá ni Èkó jẹ́ ní orílẹ̀-èdè Nàìjíríà " * 10, "yo"))
    assert "fon_sans_lettres_specifiques" in C.orthography_flags("a" * 250, "fon")
    assert any(f.startswith("caracteres_confusables") for f in C.orthography_flags("x\u03b5y", "fon"))  # epsilon grec
    assert "non_nfc" in C.orthography_flags("e\u0301", "yo")

def test_script():
    assert C.script_flags("Bonjour tout le monde", "fr") == []
    assert C.script_flags("مرحبا بالعالم", "ha")[0].startswith("ecriture_non_latine")

def test_license_and_provenance():
    good = doc("Ẹ káàárọ̀")
    assert C.license_flags(good) == [] and C.provenance_flags(good) == []
    assert "licence_hors_liste_blanche" in C.license_flags(doc("x", license="CC-BY-NC-4.0"))
    assert "licence_nc_nd" in C.license_flags(doc("x", license="CC-BY-NC-4.0"))
    assert "droits_non_verifies" in C.license_flags(doc("x", rights_status="unknown"))
    bad = doc("x", url="ftp://x", sha256="0" * 64, proof_ref="")
    f = C.provenance_flags(bad)
    assert {"url_invalide", "hash_incoherent", "provenance_manque_proof_ref"} <= set(f)
    assert "preuve_introuvable" in C.provenance_flags(good, proof_exists=lambda r: False)

def test_pedagogy_score_bounded_and_ordered():
    lesson = ("Leçon 1 : les fractions. Une fraction représente une partie d'un tout. Par exemple, la moitié s'écrit 1/2. "
              "Exercice : combien vaut 2/4 ? Donc 2/4 est égal à 1/2 parce que l'on simplifie par 2.\n- étape 1\n- étape 2\n") * 6
    s1, _ = C.pedagogy_score(doc(lesson, level="primaire", discipline="mathematiques"))
    s2, _ = C.pedagogy_score(doc("liste " * 30))
    assert 0 <= s2 < s1 <= 100
