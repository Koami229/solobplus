"""Registre des sources SAKC. La preuve de licence de chaque wiki est celle renvoyée par
l'API MediaWiki (siteinfo/rightsinfo) au moment de la collecte, stockée dans <lang>.proof.json."""
from __future__ import annotations
import json, pathlib
from .schema import Source, Resource, RightsStatus

WIKI_COUNTRY = {"fr": "XX", "en": "XX", "fon": "BJ", "yo": "NG", "ha": "NG", "wo": "SN", "sw": "TZ", "ig": "NG"}
# Pays = pays de référence principal de la langue (approximation documentée, la langue est parlée
# dans plusieurs pays: fon BJ/TG, yoruba NG/BJ, hausa NG/NE, wolof SN/GM, swahili TZ/KE/UG/CD...).

def wikipedia_source(lang: str, proof: dict) -> Source:
    ri = proof["rightsinfo"]
    lic_ok = "Creative Commons Attribution-Share Alike" in ri.get("text", "") or "by-sa" in ri.get("url", "")
    return Source(source_id=f"wikipedia-{lang}", name=proof.get("sitename", f"{lang}.wikipedia"),
                  url=f"https://{lang}.wikipedia.org", license="CC-BY-SA-4.0" if lic_ok else "UNKNOWN",
                  license_url=ri.get("url", ""),
                  rights_status=RightsStatus.VERIFIED if lic_ok else RightsStatus.PENDING, proof=proof,
                  notes="Texte des articles uniquement (extraits API). Attribution: URL + révision par ressource.")

def load_wikipedia(raw_dir: pathlib.Path) -> tuple[list[Source], list[Resource]]:
    sources, res = [], []
    for pf in sorted(raw_dir.glob("*.proof.json")):
        meta = json.loads(pf.read_text())
        lang = meta["lang"]; src = wikipedia_source(lang, meta["license_proof"]); sources.append(src)
        for line in open(raw_dir / f"{lang}.jsonl", encoding="utf-8"):
            d = json.loads(line)
            res.append(Resource(source_id=src.source_id, url=d["url"], license=src.license,
                                rights_status=src.rights_status, proof_ref=str(pf.name), country=WIKI_COUNTRY[lang],
                                language=lang, title=d["title"], text=d["text"],
                                annotation={"annotator": "auto", "labels": {"origin": "wikipedia"}}))
    return sources, res

def write_registry(sources: list[Source], path: pathlib.Path):
    path.write_text(json.dumps([{**s.__dict__, "rights_status": s.rights_status.value} for s in sources],
                               ensure_ascii=False, indent=2))
