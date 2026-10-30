"""Collecte d'un PETIT échantillon d'articles Wikipédia (CC BY-SA 4.0) via l'API MediaWiki publique.

Pour chaque wiki on enregistre la preuve de licence renvoyée par l'API elle-même
(meta=siteinfo&siprop=rightsinfo), l'URL de chaque article et l'identifiant de révision.
Aucune authentification, aucun service payant. Respect d'un délai entre requêtes.
"""
from __future__ import annotations
import argparse, json, time, urllib.error, urllib.parse, urllib.request, hashlib, datetime, pathlib

UA = "SOLOB-AI-research/0.1 (educational corpus prototype; contact: repo owner)"
LANGS = {"fr": "fr", "en": "en", "fon": "fon", "yo": "yo", "ha": "ha", "wo": "wo", "sw": "sw", "ig": "ig"}

def api(lang: str, **params) -> dict:
    params.update(format="json", formatversion="2")
    url = f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 0) or 10 * (attempt + 1))

def rights_proof(lang: str) -> dict:
    info = api(lang, action="query", meta="siteinfo", siprop="rightsinfo|general")["query"]
    return {"rightsinfo": info["rightsinfo"], "sitename": info["general"]["sitename"],
            "api_url": f"https://{lang}.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=rightsinfo",
            "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}

def collect(lang: str, max_bytes: int, out: pathlib.Path, delay: float = 1.0) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    proof = rights_proof(lang)
    seen, total, n, calls = set(), 0, 0, 0
    with open(out / f"{lang}.jsonl", "w", encoding="utf-8") as f:
        while total < max_bytes and calls < 400:
            calls += 1
            d = api(lang, action="query", generator="random", grnnamespace=0, grnlimit=1,
                    prop="extracts|revisions|info", explaintext=1, exlimit=1, rvprop="ids", inprop="url")
            for p in d.get("query", {}).get("pages", []):
                txt = (p.get("extract") or "").strip()
                if p["pageid"] in seen or len(txt) < 200:
                    continue
                seen.add(p["pageid"])
                rec = {"wiki": lang, "pageid": p["pageid"], "title": p["title"], "url": p.get("fullurl"),
                       "revid": (p.get("revisions") or [{}])[0].get("revid"), "text": txt}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                total += len(txt.encode()); n += 1
            time.sleep(delay)
    meta = {"lang": lang, "articles": n, "bytes": total, "api_calls": calls, "license_proof": proof}
    (out / f"{lang}.proof.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    return meta

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/raw/wikipedia")
    ap.add_argument("--max-bytes", type=int, default=2_000_000)
    ap.add_argument("--langs", default=",".join(LANGS))
    a = ap.parse_args()
    for l in a.langs.split(","):
        try:
            m = collect(l, a.max_bytes, pathlib.Path(a.out))
            print(l, m["articles"], m["bytes"], m["license_proof"]["rightsinfo"])
        except Exception as e:  # langue sans wiki accessible: on le dit
            print(l, "ERREUR", e)
