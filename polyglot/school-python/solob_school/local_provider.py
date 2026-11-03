"""Fournisseur expérimental « solob-local » (modèle SOLOB AI auto-hébergé), DÉSACTIVÉ par défaut.

Activation explicite: SOLOB_LOCAL_ENABLED=1 et SOLOB_LOCAL_URL=http://127.0.0.1:<port>/generate.
- Uniquement en boucle locale (127.0.0.1 / localhost / ::1): aucun service externe ni payant.
- Contrat JSON (identique à solob_ai.inference.offline_eval): requête {prompt, max_new_tokens},
  réponse {text, completion_tokens, model}.
- Délai SOLOB_LOCAL_TIMEOUT_S (défaut 10 s), plafond SOLOB_LOCAL_MAX_NEW_TOKENS (défaut 128, max 512).
Les limites existantes (rate limit, longueur de prompt, journal ai_usage_records) restent appliquées par routes.grounded_ai.
"""
from __future__ import annotations
import json, os, urllib.parse, urllib.request

LOOPBACK = {"127.0.0.1", "localhost", "::1"}
LOCAL_NOTICE = ("[EXPERIMENTAL — solob-local: petit modèle SOLOB AI auto-hébergé, NON évalué pour l'usage pédagogique. "
                "Le brouillon du modèle (localModelDraft) peut être faux; seules les citations extraites du document sont fiables. "
                "Vérifiez toute affirmation dans les sources primaires.]")

class LocalProviderError(Exception):
    pass

def enabled() -> bool:
    return os.environ.get("SOLOB_LOCAL_ENABLED", "").strip().lower() in ("1", "true", "yes") and bool(os.environ.get("SOLOB_LOCAL_URL"))

def _url() -> str:
    u = os.environ.get("SOLOB_LOCAL_URL", "")
    p = urllib.parse.urlparse(u)
    if p.scheme != "http" or p.hostname not in LOOPBACK:
        raise LocalProviderError("SOLOB_LOCAL_URL doit pointer vers une adresse de boucle locale (http://127.0.0.1:...)")
    return u

def generate(prompt: str) -> dict:
    timeout = float(os.environ.get("SOLOB_LOCAL_TIMEOUT_S", "10") or 10)
    max_new = max(1, min(512, int(os.environ.get("SOLOB_LOCAL_MAX_NEW_TOKENS", "128") or 128)))
    req = urllib.request.Request(_url(), data=json.dumps({"prompt": prompt, "max_new_tokens": max_new}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read(1_000_000).decode("utf-8"))
    except LocalProviderError: raise
    except Exception as e:  # timeout, refus de connexion, JSON invalide...
        raise LocalProviderError(f"{type(e).__name__}: {e}"[:300])
    text = body.get("text")
    if not isinstance(text, str):
        raise LocalProviderError("réponse sans champ 'text'")
    ct = body.get("completion_tokens")
    return {"text": text[:4000], "completion_tokens": int(ct) if isinstance(ct, int) and 0 <= ct <= max_new else None,
            "model": str(body.get("model") or "solob-local")[:80]}
