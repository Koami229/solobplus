"""Chargeurs SAKC v1 (Mission 3, étape 3). Sources approuvées par Koami le 2026-10-31 :
African Storybook (CC BY uniquement, licence par histoire), Google SMOL (CC BY 4.0),
Common Voice (CC0, texte), Wikibooks fr/en (CC BY-SA 4.0). FLORES+ = éval seulement (jamais ici).
Chaque Resource porte sa licence et un pointeur de preuve (proof_ref) vers data/raw/<src>/proof.json."""
from __future__ import annotations
import bz2, json, pathlib, re, xml.etree.ElementTree as ET
from .schema import Source, Resource, RightsStatus

LANGS = {"fr", "en", "fon", "yo", "ha", "wo", "sw", "ig"}
COUNTRY = {"fr": "XX", "en": "XX", "fon": "BJ", "yo": "NG", "ha": "NG", "wo": "SN", "sw": "TZ", "ig": "NG"}

# ---------- African Storybook ----------
ASB_LANG = {"English": "en", "French": "fr", "Fongbe": "fon", "Yoruba": "yo", "Hausa (Nigeria)": "ha",
            "Hausa (Niger)": "ha", "Hausa": "ha", "Hausa(Nigeria)": "ha", "Hausa(Niger)": "ha",
            "Kiswahili": "sw", "Swahili": "sw", "Igbo": "ig", "Wolof": "wo"}
ASB_LIC = {"Creative Commons: Attribution 4.0": "CC-BY-4.0", "Creative Commons: Attribution 3.0": "CC-BY-3.0"}

def parse_asb(path: pathlib.Path) -> dict:
    meta, pages, in_pages = {}, [], False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("page_text:"): in_pages = True; continue
        if line.startswith("images:"): break
        if in_pages:
            m = re.match(r"^P\d+\t(.*)$", line)
            if m: pages.append(m.group(1).strip())
        else:
            m = re.match(r"^(\w+):\t(.*)$", line)
            if m: meta[m.group(1)] = m.group(2).strip()
    meta["text"] = "\n".join(p for p in pages if p)
    return meta

def load_asb(raw: pathlib.Path, stats) -> list[Resource]:
    out = []
    for f in sorted((raw / "repo" / "data").glob("*.txt")):
        m = parse_asb(f); lang = ASB_LANG.get(m.get("lang", ""))
        if not lang: stats["asb_langue_hors_cible"] += 1; continue
        lic = ASB_LIC.get(m.get("lic", ""))
        st = RightsStatus.VERIFIED if lic else RightsStatus.REJECTED   # NC ou inconnu -> bloqué par la porte
        if not lic: stats["asb_licence_nc_ou_inconnue"] += 1
        out.append(Resource(source_id="african-storybook", url=m.get("url", ""), license=lic or m.get("lic", "UNKNOWN"),
                            rights_status=st, proof_ref=f"asb/repo/data/{f.name}#lic", country=COUNTRY[lang],
                            language=lang, discipline="litterature", level="primaire", title=m.get("title", ""),
                            text=m["text"], annotation={"annotator": "auto", "labels": {
                                "origin": "african-storybook", "asb_id": m.get("id"), "author": m.get("author"),
                                "asb_level": m.get("level"), "license_declared": m.get("lic"), "educational": True}}))
    return out

# ---------- regroupement de phrases ----------
def chunks(sents: list[str], size: int = 1500):
    buf, n = [], 0
    for s in sents:
        buf.append(s); n += len(s) + 1
        if n >= size: yield "\n".join(buf); buf, n = [], 0
    if buf: yield "\n".join(buf)

def uniq(xs):
    seen = set(); return [x for x in (y.strip() for y in xs) if x and not (x in seen or seen.add(x))]

# ---------- Google SMOL ----------
def load_smol(raw: pathlib.Path, stats) -> list[Resource]:
    out = []
    by_lang: dict[str, list[tuple[str, str]]] = {}
    for f in sorted(raw.glob("*.jsonl")):
        kind = f.name.split("_")[0]
        for line in open(f, encoding="utf-8"):
            d = json.loads(line)
            for side, lang_key in (("src", "sl"), ("trg", "tl")):
                lang = d[lang_key]
                if lang not in LANGS or lang == "en":   # côté anglais: texte source (souvent synthétique) écarté
                    continue
                if kind == "smoldoc":
                    txt = "\n".join(d["srcs"] if side == "src" else d["trgs"])
                    by_lang.setdefault(lang, []).append((f"{f.name}#{d['id']}", txt))
                else:
                    by_lang.setdefault(lang + "#sent", []).append((f.name, d[side]))
    for key, items in by_lang.items():
        lang = key.split("#")[0]
        if key.endswith("#sent"):
            texts = uniq(t for _, t in items)
            docs = [(f"smolsent:{lang}:{i}", t) for i, t in enumerate(chunks(texts))]
        else:
            seen = set(); docs = []
            for ref, t in items:
                if t not in seen: seen.add(t); docs.append((ref, t))
        for ref, t in docs:
            out.append(Resource(source_id="google-smol", url=f"https://huggingface.co/datasets/google/smol#{ref}",
                                license="CC-BY-4.0", rights_status=RightsStatus.VERIFIED, proof_ref="smol/proof.json",
                                country=COUNTRY[lang], language=lang, title=ref, text=t,
                                annotation={"annotator": "auto", "labels": {"origin": "google-smol",
                                            "note": "traduction humaine d'un texte source anglais", "educational": False}}))
    return out

# ---------- Common Voice (texte des phrases, CC0) ----------
def load_cv(raw: pathlib.Path, stats, cap_chars: int = 3_000_000) -> list[Resource]:
    out = []
    for d in sorted(p for p in raw.iterdir() if p.is_dir()):
        lang = d.name
        if lang not in LANGS: continue
        sents = []
        for f in sorted(d.glob("*.txt")):
            sents += [(f.name, s) for s in f.read_text(encoding="utf-8", errors="replace").splitlines()]
        texts = uniq(s for _, s in sents)
        total = 0; kept = []
        for t in texts:
            if total >= cap_chars: stats[f"cv_cap_{lang}"] += 1; continue
            kept.append(t); total += len(t)
        for i, t in enumerate(chunks(kept)):
            out.append(Resource(source_id="common-voice", url=f"https://github.com/common-voice/common-voice/tree/48982e44de762baa6d781638d7252e880677e231/server/data/{lang}#{i}",
                                license="CC0-1.0", rights_status=RightsStatus.VERIFIED, proof_ref="commonvoice/proof.json",
                                country=COUNTRY[lang], language=lang, title=f"cv:{lang}:{i}", text=t,
                                annotation={"annotator": "auto", "labels": {"origin": "common-voice", "educational": False}}))
    return out

# ---------- Wikibooks (dump 20261001) ----------
def load_wikibooks(raw: pathlib.Path, stats, cap_chars: int = 15_000_000) -> list[Resource]:
    import mwparserfromhell
    out = []
    for lang in ("fr", "en"):
        f = raw / f"{lang}wikibooks-20261001-pages-articles.xml.bz2"
        if not f.exists(): stats[f"wikibooks_{lang}_absent"] += 1; continue
        total = 0
        for ev, el in ET.iterparse(bz2.open(f), events=("end",)):
            if not el.tag.endswith("}page"): continue
            ns_ = el.tag[:-4]
            ns = el.findtext(f"{ns_}ns"); title = el.findtext(f"{ns_}title") or ""
            red = el.find(f"{ns_}redirect"); rev = el.find(f"{ns_}revision")
            if ns != "0" or red is not None or rev is None: el.clear(); continue
            wt = rev.findtext(f"{ns_}text") or ""; rid = rev.findtext(f"{ns_}id")
            el.clear()
            if total >= cap_chars: stats[f"wikibooks_{lang}_cap"] += 1; continue
            try: txt = mwparserfromhell.parse(wt).strip_code(normalize=True, collapse=True)
            except Exception: stats["wikibooks_parse_err"] += 1; continue
            txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
            if len(txt) < 200: stats[f"wikibooks_{lang}_court"] += 1; continue
            total += len(txt)
            out.append(Resource(source_id=f"wikibooks-{lang}", url=f"https://{lang}.wikibooks.org/w/index.php?oldid={rid}",
                                license="CC-BY-SA-4.0", rights_status=RightsStatus.VERIFIED, proof_ref="wikibooks/proof.json",
                                country="XX", language=lang, discipline="inconnu", level="inconnu", title=title, text=txt,
                                annotation={"annotator": "auto", "labels": {"origin": "wikibooks", "book": title.split("/")[0],
                                            "rev_id": rid, "educational": True}}))
    return out

def load_v0(v0: pathlib.Path) -> list[Resource]:
    out = []
    for s in ("train", "val", "test"):
        for line in open(v0 / f"{s}.jsonl", encoding="utf-8"):
            d = json.loads(line); d["rights_status"] = RightsStatus(d["rights_status"]); d.pop("sha256", None)
            out.append(Resource(**d))
    return out
