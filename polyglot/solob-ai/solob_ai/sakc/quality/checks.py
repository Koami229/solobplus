"""Contrôles unitaires purs (sans E/S). Chaque fonction renvoie une liste de drapeaux (str) ou un score."""
from __future__ import annotations
import hashlib, re, unicodedata
from collections import Counter
from urllib.parse import urlparse
from ..schema import OPEN_LICENSES, LEVELS, DISCIPLINES

WORD = re.compile(r"\w+", re.U)
SENT = re.compile(r"(?<=[.!?])\s+")

def words(t: str) -> list[str]: return WORD.findall(t.lower())

# ---------------------------------------------------------------- texte généré / gabarit
def repetition_flags(text: str) -> list[str]:
    f, w = [], words(text)
    if len(w) >= 50:
        tri = [tuple(w[i:i + 3]) for i in range(len(w) - 2)]
        dup = 1 - len(set(tri)) / len(tri)
        if dup > 0.35: f.append("repetition_trigrammes")
    sents = [s.strip().lower() for s in SENT.split(text) if len(s.strip()) > 20]
    if len(sents) >= 4 and Counter(sents).most_common(1)[0][1] / len(sents) > 0.25: f.append("phrases_repetees")
    return f

def lexical_diversity(text: str, window: int = 300) -> float | None:
    """TTR moyen sur fenêtres fixes (insensible à la longueur). None si texte trop court."""
    w = words(text)
    if len(w) < window: return None
    vals = [len(set(w[i:i + window])) / window for i in range(0, len(w) - window + 1, window)]
    return sum(vals) / len(vals)

def ngrams(text: str, n: int = 6) -> set[str]:
    w = words(text)
    return {" ".join(w[i:i + n]) for i in range(len(w) - n + 1)}

def template_coverage(text: str, templates: set[str], n: int = 6) -> float:
    w = words(text)
    if len(w) < n: return 0.0
    cov = [False] * len(w)
    for i in range(len(w) - n + 1):
        if " ".join(w[i:i + n]) in templates:
            for j in range(i, i + n): cov[j] = True
    return sum(cov) / len(w)

# Motifs d'articles générés par bot/gabarit observés dans les petites Wikipédias (stubs démographiques,
# géographiques ou calendaires). Volontairement génériques: la détection principale est la couverture de gabarits
# calculée sur les données elles-mêmes (n-grammes partagés par beaucoup d'articles d'une même source).
BOT_PATTERNS = [
    re.compile(r"\b(19|20)\d\d\b.*\b(census|recensement|ìkànìaàn|ikaniyan)\b", re.I),
    re.compile(r"\bpopulation\b.{0,40}\b\d[\d ,.]{2,}\b", re.I),
]
def bot_pattern_flags(text: str, source_id: str) -> list[str]:
    if not source_id.startswith("wikipedia-"): return []
    w = words(text)
    f = []
    if len(w) < 60: f.append("stub_court_wikipedia")
    if any(p.search(text) for p in BOT_PATTERNS) and len(w) < 150: f.append("motif_stub_demographique")
    return f

# ---------------------------------------------------------------- linguistique
YO_TONED = set("áàéèẹ́ẹ̀íìóòọ́ọ̀úùńǹḿ")
def _vowels(t): return [c for c in unicodedata.normalize("NFD", t.lower()) if c in "aeiou"]
def tone_mark_ratio(text: str) -> float:
    """Part des voyelles portant un accent tonal (aigu/grave) en décomposition NFD."""
    d = unicodedata.normalize("NFD", text.lower())
    vow, marked = 0, 0
    for i, c in enumerate(d):
        if c in "aeiouɛɔ":
            vow += 1
            j = i + 1
            while j < len(d) and unicodedata.combining(d[j]):
                if d[j] in "\u0301\u0300\u0302\u030c": marked += 1; break
                j += 1
    return marked / vow if vow else 0.0

FON_LETTERS = set("ɖɛɔƐƆƉ")
CONFUSABLES = {"\u03b5": "ɛ (U+025B) au lieu de ε grec", "\u0254": None, "\u0186": None,
               "\u0190": None, "\u0189": None, "\u00f0": "ɖ (U+0256) au lieu de ð", "\u0111": "ɖ au lieu de đ",
               "\u03a3": "Ɛ au lieu de Σ grec", "\u2202": "ɖ au lieu de ∂"}
def orthography_flags(text: str, lang: str) -> list[str]:
    f = []
    if lang == "yo":
        r = tone_mark_ratio(text)
        if r < 0.05: f.append("yo_sans_tons")
        elif r < 0.15: f.append("yo_tons_partiels")
        if re.search(r"[ẹọṣ]", text) is None and len(text) > 300: f.append("yo_sans_points_souscrits")
    if lang == "fon":
        if not (FON_LETTERS & set(text)) and len(text) > 200: f.append("fon_sans_lettres_specifiques")
        if tone_mark_ratio(text) < 0.03 and len(text) > 300: f.append("fon_sans_tons")
    if lang in ("fon", "yo", "ig", "ha", "wo"):
        bad = {c for c in text if CONFUSABLES.get(c)}
        if bad: f.append("caracteres_confusables:" + "".join(sorted(bad)))
    if unicodedata.normalize("NFC", text) != text: f.append("non_nfc")
    return f

def script_flags(text: str, lang: str) -> list[str]:
    letters = [c for c in text if c.isalpha()]
    if not letters: return ["aucune_lettre"]
    nonlat = sum(1 for c in letters if not unicodedata.name(c, "").startswith("LATIN"))
    r = nonlat / len(letters)
    if r > 0.10: return [f"ecriture_non_latine:{int(r*100)}pct"]
    if r > 0.01: return ["ecriture_mixte"]
    return []

# ---------------------------------------------------------------- licence / provenance
def license_flags(d: dict) -> list[str]:
    f = []
    if d.get("license") not in OPEN_LICENSES: f.append("licence_hors_liste_blanche")
    if re.search(r"\b(NC|ND)\b|non.?commercial|noderiv", d.get("license", ""), re.I): f.append("licence_nc_nd")
    if d.get("rights_status") != "rights_verified": f.append("droits_non_verifies")
    return f

def provenance_flags(d: dict, proof_exists=lambda ref: True) -> list[str]:
    f = []
    for k in ("source_id", "url", "license", "proof_ref", "language", "version"):
        if not d.get(k): f.append(f"provenance_manque_{k}")
    u = urlparse(d.get("url", ""))
    if u.scheme not in ("https", "http") or not u.netloc: f.append("url_invalide")
    elif u.scheme == "http": f.append("url_non_https")
    if d.get("sha256") != hashlib.sha256(d.get("text", "").encode("utf-8")).hexdigest(): f.append("hash_incoherent")
    if d.get("proof_ref") and not proof_exists(d["proof_ref"]): f.append("preuve_introuvable")
    if d.get("country") in ("", "XX"): f.append("pays_non_renseigne")
    return f

# ---------------------------------------------------------------- pédagogie
EDU_MARKERS = re.compile(r"\b(par exemple|exemple|exercice|question|définition|leçon|chapitre|for example|e\.g\.|exercise|"
                         r"definition|lesson|chapter|step|étape|therefore|donc|because|parce que|mfano|zoezi|misali|"
                         r"àpẹẹrẹ|ihe atụ)\b", re.I)
def pedagogy_score(d: dict) -> tuple[int, dict]:
    """Heuristique 0-100, NON validée par des humains: sert à prioriser la relecture, pas à juger."""
    t = d.get("text", ""); w = words(t); parts = {}
    sents = [s for s in SENT.split(t) if s.strip()]
    asl = len(w) / max(1, len(sents))
    parts["longueur_phrases"] = 20 if 8 <= asl <= 25 else 10 if 5 <= asl <= 35 else 0
    parts["longueur_doc"] = 15 if 150 <= len(w) <= 3000 else 8 if len(w) >= 80 else 0
    m = len(EDU_MARKERS.findall(t))
    parts["marqueurs_didactiques"] = min(25, m * 5)
    struct = len(re.findall(r"^\s*([-*•]|\d+[.)])\s", t, re.M)) + t.count("?")
    parts["structure"] = min(15, struct * 3)
    ld = lexical_diversity(t, 100)
    parts["diversite"] = 0 if ld is None else 10 if 0.45 <= ld <= 0.85 else 4
    parts["metadonnees"] = (8 if d.get("level") in LEVELS and d.get("level") not in ("general", "inconnu") else 0) + \
                           (7 if d.get("discipline") in DISCIPLINES and d.get("discipline") not in ("general", "inconnu") else 0)
    return min(100, sum(parts.values())), parts
