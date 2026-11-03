"""Collecte d'un PETIT échantillon déterministe du jeu wikimedia/wikipedia (dump 20231101, CC BY-SA)
via l'API publique datasets-server de Hugging Face (lecture seule, sans compte).

Preuves de licence enregistrées: (1) rightsinfo renvoyé par l'API MediaWiki du wiki concerné,
(2) champ licence de la fiche du jeu de données Hugging Face. Échantillonnage par pas régulier
(offsets répartis sur tout le dump) pour éviter le biais alphabétique."""
from __future__ import annotations
import argparse, json, time, urllib.error, urllib.parse, urllib.request, datetime, pathlib
from .collect_wikipedia import rights_proof

UA = {"User-Agent": "SOLOB-AI-research/0.1 (educational corpus prototype)"}
DS = "wikimedia/wikipedia"; CFG = "20231101"

def get(url):
    for a in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or a == 5: raise
            time.sleep(5 * (a + 1))

def collect(lang, max_bytes, out: pathlib.Path):
    out.mkdir(parents=True, exist_ok=True)
    base = "https://datasets-server.huggingface.co"
    q = lambda ep, **p: get(f"{base}/{ep}?" + urllib.parse.urlencode({"dataset": DS, "config": f"{CFG}.{lang}", "split": "train", **p}))
    n_rows = get(f"{base}/size?" + urllib.parse.urlencode({"dataset": DS, "config": f"{CFG}.{lang}"}))["size"]["config"]["num_rows"]
    info = get(f"https://huggingface.co/api/datasets/{DS}")
    hf_license = [t for t in info.get("tags", []) if t.startswith("license:")]
    proof = {"mediawiki": rights_proof(lang), "hf_dataset": {"id": DS, "config": f"{CFG}.{lang}", "license_tags": hf_license,
             "card": f"https://huggingface.co/datasets/{DS}", "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}}
    pages = -(-n_rows // 100); take = 100 if n_rows < 20000 else 15; total = n = 0; step = max(1, pages // 300)
    with open(out / f"{lang}.jsonl", "w", encoding="utf-8") as f:
        for pg in range(0, pages, step):
            for row in q("rows", offset=pg * 100, length=100)["rows"][:take]:
                r = row["row"]
                if len(r["text"]) < 200: continue
                f.write(json.dumps({"wiki": lang, "pageid": r["id"], "title": r["title"], "url": r["url"],
                                    "revid": f"dump-{CFG}", "text": r["text"]}, ensure_ascii=False) + "\n")
                total += len(r["text"].encode()); n += 1
                if total >= max_bytes: break
            if total >= max_bytes: break
            time.sleep(0.3)
    meta = {"lang": lang, "articles": n, "bytes": total, "dump_rows": n_rows, "license_proof": proof["mediawiki"], "proof": proof}
    (out / f"{lang}.proof.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2)); return meta

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default="data/raw/wikipedia")
    ap.add_argument("--max-bytes", type=int, default=2_000_000); ap.add_argument("--langs", default="fr,en,fon,yo,ha,wo,sw,ig")
    a = ap.parse_args()
    for l in a.langs.split(","):
        try: m = collect(l, a.max_bytes, pathlib.Path(a.out)); print(l, m["articles"], m["bytes"], m["dump_rows"], m["proof"]["hf_dataset"]["license_tags"], m["license_proof"]["rightsinfo"], flush=True)
        except Exception as e: print(l, "ERREUR", repr(e), flush=True)
