"""Cadre des benchmarks pédagogiques SOLOB AI. Seuls les items `expert_reviewed` (avec relecteur et date)
comptent dans un score. Les items `draft` sont des exemples NON VALIDÉS."""
from __future__ import annotations
from dataclasses import dataclass, field
import json, pathlib, re, unicodedata

DISCIPLINES = ["mathematiques", "physique", "chimie", "biologie", "informatique", "histoire_africaine",
               "geographie", "langues", "comprehension", "raisonnement_pedagogique"]
STATUSES = {"draft", "expert_reviewed", "retired"}
ERROR_TAGS = {"hallucination", "erreur_scientifique", "biais_culturel", "hors_programme", "langue_incorrecte"}

@dataclass
class Item:
    item_id: str
    discipline: str
    country: str          # ISO alpha-2 ou "AF" (panafricain)
    level: str            # primaire | college | lycee | universite
    language: str
    curriculum_ref: str   # référence au programme officiel (à renseigner par l'expert)
    question: str
    reference: str        # réponse de référence
    accepted: list = field(default_factory=list)
    review_status: str = "draft"
    reviewer: str | None = None
    reviewed_at: str | None = None
    notes: str = ""

    def validate(self) -> list[str]:
        e = []
        if self.discipline not in DISCIPLINES: e.append("discipline")
        if self.review_status not in STATUSES: e.append("statut")
        if self.review_status == "expert_reviewed" and not (self.reviewer and self.reviewed_at): e.append("relecteur/date manquants")
        return e

def load(path: pathlib.Path) -> list[Item]:
    return [Item(**json.loads(l)) for l in open(path, encoding="utf-8") if l.strip()]

def norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s).strip().lower().rstrip("."))

def score(items: list[Item], answers: dict[str, str], judgments: dict[str, list[str]] | None = None) -> dict:
    """answers: item_id -> réponse du modèle; judgments: item_id -> étiquettes d'erreur posées par un relecteur humain."""
    judgments = judgments or {}
    counted = [i for i in items if i.review_status == "expert_reviewed" and not i.validate()]
    res = {"items_total": len(items), "items_counted": len(counted), "items_draft_ignored": sum(i.review_status == "draft" for i in items),
           "by": {}, "error_rates": {t: 0.0 for t in ERROR_TAGS}}
    if not counted: res["note"] = "aucun item validé par un expert: aucun score n'est publiable"; return res
    for i in counted:
        k = f"{i.discipline}|{i.country}|{i.level}"; b = res["by"].setdefault(k, {"n": 0, "correct": 0})
        b["n"] += 1; b["correct"] += norm(answers.get(i.item_id, "")) in {norm(i.reference), *map(norm, i.accepted)}
        for t in judgments.get(i.item_id, []):
            if t in ERROR_TAGS: res["error_rates"][t] += 1
    for t in ERROR_TAGS: res["error_rates"][t] = round(res["error_rates"][t] / len(counted), 4)
    res["accuracy"] = round(sum(b["correct"] for b in res["by"].values()) / len(counted), 4); return res
