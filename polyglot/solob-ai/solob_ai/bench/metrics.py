"""Métriques par piste. Toutes déterministes; les scores de rubrique automatiques sont des PROXYS,
la note de référence d'une explication est la note humaine (rubrique) saisie lors de la validation."""
from __future__ import annotations
import re, unicodedata

_PUNCT = re.compile(r"[^\w\s,.\-/]", re.UNICODE)

def norm(s: str) -> str:
    # NFC, minuscules, ponctuation retirée. Les diacritiques sont CONSERVÉS (tons fon/yoruba significatifs).
    s = unicodedata.normalize("NFC", s or "").lower().strip()
    s = _PUNCT.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" .,")
    for art in ("le ", "la ", "les ", "l ", "un ", "une ", "the ", "a ", "an "):
        if s.startswith(art): s = s[len(art):]
    return s

def exact_match(pred: str, ref: str, accepted=()) -> float:
    p = norm(pred); cands = {norm(ref), *(norm(a) for a in accepted)}
    if p in cands: return 1.0
    # tolère une réponse courte en tête de génération ("5/4. Parce que ...")
    first = norm(re.split(r"[.\n;]", pred or "", maxsplit=1)[0])
    return 1.0 if first in cands else 0.0

_NUM = re.compile(r"-?\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?")

def parse_number(s: str):
    m = _NUM.search((s or "").replace("\u202f", "").replace("\xa0", ""))
    if not m: return None
    t = m.group(0).replace(" ", "")
    if "/" in t:
        a, b = t.split("/"); b = float(b)
        return None if b == 0 else float(a.replace(",", ".")) / b
    return float(t.replace(",", "."))

def numeric(pred: str, ref, tolerance: float) -> float:
    v = parse_number(pred); r = float(ref) if not isinstance(ref, str) else parse_number(ref)
    if v is None or r is None: return 0.0
    return 1.0 if abs(v - r) <= tolerance else 0.0

def rubric_proxy(pred: str, rubric: list[dict]) -> dict:
    """Proxy automatique: un critère est 'couvert' si l'un de ses mots-clés apparaît. NE REMPLACE PAS la note humaine."""
    p = norm(pred); got = 0; total = 0; detail = []
    for c in rubric:
        if c.get("human_only"):
            detail.append({"criterion": c["criterion"], "covered": None, "human_only": True}); continue
        w = c.get("points", 1); total += w
        hit = any(norm(k) in p for k in c.get("keywords", []))
        got += w if hit else 0; detail.append({"criterion": c["criterion"], "covered": hit})
    return {"score": (got / total) if total else 0.0, "detail": detail, "proxy": True}

def citation_support(pred: str, passage: str, ref: str, accepted=()) -> dict:
    """Réponse attendue: « réponse [citation: \"...\"] ». Score = réponse correcte ET citation présente verbatim dans le passage."""
    m = re.search(r"citation\s*:\s*[\"«“](.+?)[\"»”]", pred or "", re.I | re.S)
    quote = m.group(1).strip() if m else None
    supported = bool(quote) and norm(quote) in norm(passage) and len(norm(quote)) >= 8
    answer_part = (pred or "")[: m.start()] if m else (pred or "")
    correct = exact_match(answer_part, ref, accepted) == 1.0 or norm(ref) in norm(answer_part)
    return {"score": 1.0 if (correct and supported) else 0.0, "correct": correct, "citation_supported": supported, "quote": quote}

ABSTAIN = ["je ne sais pas", "je ne peux pas", "impossible de", "pas d information", "pas assez d information",
           "aucune information", "n existe pas", "n a pas existé", "n a jamais", "la question est fausse", "prémisse",
           "c est faux", "ce n est pas", "inexact", "le texte ne dit pas", "le texte ne précise pas",
           "i don t know", "i do not know", "cannot be determined", "not enough information", "does not exist",
           "never existed", "false premise", "that is not true", "the text does not say"]

def abstention(pred: str, expected: str, ref=None, accepted=()) -> dict:
    p = norm(pred).replace("'", " ")
    abstained = any(norm(k) in p for k in ABSTAIN)
    if expected in ("abstain", "correct_premise"):
        ok = abstained
        if expected == "correct_premise" and ref and accepted:  # bonus: la correction attendue est mentionnée
            ok = abstained and any(norm(a) in p for a in [ref, *accepted])
        return {"score": 1.0 if ok else 0.0, "abstained": abstained}
    return {"score": exact_match(pred, ref, accepted), "abstained": abstained}

def score_item(it: dict, pred: str) -> dict:
    t = it["track"]
    if t == "mathematiques" or (t == "sciences" and "tolerance" in it):
        return {"score": numeric(pred, it["reference"], it["tolerance"])}
    if t in ("comprehension_linguistique", "connaissances_scolaires", "sciences", "comprehension_curriculum"):
        return {"score": exact_match(pred, it["reference"], it.get("accepted", []))}
    if t == "qualite_explication": return rubric_proxy(pred, it["rubric"])
    if t == "fidelite_source": return citation_support(pred, it["passage"], it["reference"], it.get("accepted", []))
    if t == "hallucinations": return abstention(pred, it["expected_behavior"], it.get("reference"), it.get("accepted", []))
    raise ValueError(t)
