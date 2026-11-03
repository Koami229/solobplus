"""Schéma des items du benchmark et validation stricte."""
from __future__ import annotations
import json, pathlib, re

TRACKS = {
    "comprehension_linguistique": "exact_match",
    "connaissances_scolaires": "exact_match",
    "mathematiques": "numeric",
    "sciences": "exact_match_or_numeric",
    "comprehension_curriculum": "exact_match",
    "qualite_explication": "rubric",
    "fidelite_source": "citation_support",
    "hallucinations": "abstention",
}
LANGS = {"fr", "en", "fon", "yo", "ha", "sw", "wo", "ig"}
STATUSES = {"draft", "validated"}
AUTHORS_MACHINE = "machine-draft"
LICENSE_OK = {"CC-BY-4.0", "CC0-1.0", "CC-BY-SA-4.0"}
REQUIRED = ["item_id", "track", "language", "country", "level", "curriculum_ref", "question", "reference",
            "source", "license", "author", "status", "reviewer_ids", "needs_native_speaker"]
ID_RE = re.compile(r"^[a-z_]+-[a-z]{2,3}-\d{4}$")

def validate(it: dict) -> list[str]:
    e = [f"champ manquant: {k}" for k in REQUIRED if k not in it]
    if e: return e
    if not ID_RE.match(it["item_id"]): e.append("item_id invalide")
    if it["track"] not in TRACKS: e.append("track inconnue")
    if it["language"] not in LANGS: e.append("langue inconnue")
    if it["status"] not in STATUSES: e.append("statut invalide")
    if it["license"] not in LICENSE_OK: e.append("licence hors liste blanche")
    if not isinstance(it["reviewer_ids"], list): e.append("reviewer_ids doit être une liste")
    if it["status"] == "validated" and len(set(it["reviewer_ids"])) < 2: e.append("validated exige >= 2 relecteurs distincts")
    if it["author"] == AUTHORS_MACHINE and it["status"] == "validated" and not it["reviewer_ids"]: e.append("item machine validé sans relecteur")
    if it["needs_native_speaker"]:
        # On n'invente pas de texte en langue nationale: la question reste vide tant qu'un locuteur ne l'a pas traduite.
        if it["question"] is not None or it["reference"] is not None: e.append("item à traduire: question/reference doivent être null")
        if not it.get("translate_from"): e.append("item à traduire: translate_from requis")
        if it["status"] == "validated": e.append("item non traduit ne peut être validé")
    else:
        if not it["question"]: e.append("question vide")
        if it["reference"] is None and it.get("expected_behavior") != "abstain": e.append("reference vide")
    m = TRACKS.get(it["track"])
    if not it["needs_native_speaker"]:
        if m == "numeric" and not isinstance(it.get("tolerance"), (int, float)): e.append("tolérance numérique requise")
        if m == "rubric" and not it.get("rubric"): e.append("rubrique requise")
        if m == "citation_support" and not it.get("passage"): e.append("passage requis")
        if m == "abstention" and it.get("expected_behavior") not in {"abstain", "correct_premise", "answer"}: e.append("expected_behavior requis")
    return e

def load_items(d: str | pathlib.Path) -> list[dict]:
    out = []
    for p in sorted(pathlib.Path(d).glob("*.jsonl")):
        for n, l in enumerate(p.open(encoding="utf-8"), 1):
            if l.strip(): out.append(json.loads(l))
    ids = [i["item_id"] for i in out]
    if len(ids) != len(set(ids)): raise ValueError("item_id en double")
    return out
