"""Rééquilibrage du mélange de langues (constat Mission 3 : fon/yo/ha/wo/ig ont régressé car fr+en dominaient).
Échantillonnage par température : p_l ∝ n_l^(1/T) (T=1 : proportionnel ; T→∞ : uniforme), avec plancher et plafond
optionnels, puis renormalisation. n_l = taille du flux d'entraînement de la langue (jetons)."""
from __future__ import annotations

def temperature_weights(sizes: dict[str, int], temperature: float = 3.0, floor: float = 0.0, cap: float = 1.0) -> dict[str, float]:
    if temperature <= 0: raise ValueError("temperature > 0")
    langs = sorted(l for l, n in sizes.items() if n > 0)
    if not langs: raise ValueError("aucune langue non vide")
    if floor * len(langs) > 1 or cap * len(langs) < 1: raise ValueError("plancher/plafond incompatibles")
    p = {l: sizes[l] ** (1.0 / temperature) for l in langs}; s = sum(p.values()); p = {l: v / s for l, v in p.items()}
    for _ in range(100):  # projection itérative sur [floor, cap]
        fixed = {l: min(max(v, floor), cap) for l, v in p.items()}
        free = [l for l in langs if floor < p[l] < cap]
        excess = 1.0 - sum(fixed.values())
        if abs(excess) < 1e-12 or not free: p = fixed; break
        fs = sum(p[l] for l in free); p = {l: (fixed[l] + excess * p[l] / fs) if l in free else fixed[l] for l in langs}
    s = sum(p.values()); return {l: round(v / s, 6) for l, v in p.items()}

def effective_epochs(sizes: dict[str, int], weights: dict[str, float], tokens_seen: int) -> dict[str, float]:
    """Nombre de passages estimé par langue : signale le risque de surapprentissage des petites langues."""
    return {l: round(weights[l] * tokens_seen / sizes[l], 3) for l in weights if sizes.get(l)}
