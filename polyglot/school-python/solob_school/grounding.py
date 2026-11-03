"""Port of extractGroundedCitations / mock AI from src/lib/school/service.ts and src/lib/ai/provider.ts.
No live provider is called (no paid service): MOCK_DEMO is deterministic."""
from __future__ import annotations
import math, re, unicodedata

MOCK_NOTICE = ("[DEMO / MOCK MODE — No external AI_API_KEY configured. This response is generated deterministically from your "
               "uploaded document excerpts. AI responses are fallible by design; never rely on unverified claims without checking "
               "the cited source passages.]")
_KW = re.compile(r"[^a-z0-9àâçéèêëîïôûùüÿñæœ\s]", re.I)

def keywords(text: str, min_len: int) -> list[str]:
    return [w for w in _KW.sub(" ", text.lower()).split() if len(w) >= min_len]

def js_round2(x: float) -> float:
    return math.floor(x * 100 + 0.5) / 100

def extract_citations(doc: dict | None, query: str) -> tuple[list[dict], str]:
    if not doc or not (doc["extracted_text"] or "").strip():
        return [], "HIGH"
    text = doc["extracted_text"].strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", text) if len(s.strip()) > 20]
    kws = [w for w in keywords(query, 1) if len(w) > 3]
    scored = []
    for s in sentences:
        if kws:
            low = s.lower(); hits = sum(1 for k in kws if k in low)
            scored.append((s, min(1.0, hits / max(1, min(4, len(kws))))))
        else:
            scored.append((s, 0.5))
    scored.sort(key=lambda t: -t[1])  # stable, like Array.prototype.sort
    top = scored[:3]
    if not top:
        top = [(text[:240], 0.35)]
        unc = "MEDIUM"
    else:
        best = top[0][1]
        unc = "LOW" if best >= 0.6 and doc["verified_source"] else "MEDIUM" if best >= 0.25 else "HIGH"
    return [{"sourceTitle": doc["title"], "documentId": doc["id"], "excerpt": s[:300],
             "relevanceScore": js_round2(max(0.25, sc)), "verifiedSource": bool(doc["verified_source"])} for s, sc in top], unc

def top_keywords(text: str) -> list[str]:
    out: list[str] = []
    for w in keywords(text, 5):
        if w not in out: out.append(w)
        if len(out) == 4: break
    return out or ["concept", "analyse"]

def extract_text(data: bytes, mime: str) -> str:
    raw = data.decode("utf-8", errors="replace")
    if mime == "application/pdf":
        parts = re.findall(r"\(([^()]{3,400})\)", raw)
        if parts:
            return " ".join(parts)
        t = re.sub(r"%PDF-\d\.\d", " ", raw)
        t = re.sub(r"\b(obj|endobj|stream|endstream|xref|trailer|startxref)\b", " ", t)
        t = "".join(ch if ch.isspace() or unicodedata.category(ch)[0] in "LNP" else " " for ch in t)
        return re.sub(r"\s+", " ", t).strip()
    return raw.replace("\x00", "")
