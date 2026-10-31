"""Accord inter-annotateurs (Cohen's kappa), sans dépendance externe."""
from __future__ import annotations
from collections import Counter

def cohen_kappa(a: list[str], b: list[str]) -> float | None:
    """Kappa de Cohen pour deux annotateurs sur les mêmes items. None si non défini (0 item)."""
    if len(a) != len(b): raise ValueError("listes de longueurs différentes")
    n = len(a)
    if n == 0: return None
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    if pe == 1.0: return 1.0 if po == 1.0 else 0.0
    return (po - pe) / (1 - pe)

def pairs_from_reviews(rows):
    """rows: itérable de (item_id, reviewer_id, decision, created_at). Prend les deux PREMIÈRES relectures par item
    (relecteur 1 = le plus ancien) — même convention que la vue SQL ai_review_pairs."""
    by = {}
    for item, rev, dec, ts in sorted(rows, key=lambda r: (r[0], r[3])):
        by.setdefault(item, []).append(dec)
    a, b = [], []
    for decs in by.values():
        if len(decs) >= 2: a.append(decs[0]); b.append(decs[1])
    return a, b

def interpret(k: float | None) -> str:
    if k is None: return "non défini"
    return ("faible" if k < 0.2 else "passable" if k < 0.4 else "modéré" if k < 0.6
            else "substantiel" if k < 0.8 else "presque parfait")  # échelle Landis & Koch (1977)
