"""CLI de validation humaine.
  python -m solob_ai.review.cli export-items  data/sakc/v1 --out items.jsonl [--per-lang 20]
      → items 'resource' à relire, priorisés par drapeaux qualité (aucune écriture en base)
  python -m solob_ai.review.cli import-items  items.jsonl --dsn $DSN      (INSERT ... ON CONFLICT DO NOTHING)
  python -m solob_ai.review.cli export-reviews --dsn $DSN --out reviews.jsonl
  python -m solob_ai.review.cli kappa (--dsn $DSN | --reviews reviews.jsonl) [--kind K] [--language L]
Le DSN se passe en argument ou via SOLOB_REVIEW_DSN; il n'est jamais écrit sur disque."""
from __future__ import annotations
import argparse, json, os, pathlib, sys
from collections import defaultdict
from .agreement import cohen_kappa, pairs_from_reviews, interpret

KINDS = ("question", "answer", "translation", "explanation", "correction", "resource")

def build_items(vdir: pathlib.Path, per_lang: int = 20):
    flags = {}
    fp = vdir / "quality" / "flags.jsonl"
    if fp.exists():
        for l in fp.open(encoding="utf-8"):
            d = json.loads(l); flags[d["sha256"]] = d["flags"]
    by_lang = defaultdict(list)
    for l in (vdir / "educational.jsonl").open(encoding="utf-8"):
        d = json.loads(l); by_lang[d["language"]].append(d)
    out = []
    for lang, docs in sorted(by_lang.items()):
        docs.sort(key=lambda d: (-len(flags.get(d["sha256"], [])), d["sha256"]))   # déterministe, signalés d'abord
        for d in docs[:per_lang]:
            out.append({"item_id": f"res-{vdir.name}-{d['sha256'][:16]}", "kind": "resource", "language": lang,
                        "source_ref": f"sakc:{vdir.name}:{d['sha256']}", "sakc_sha256": d["sha256"],
                        "payload": {"title": d.get("title", ""), "text": d["text"][:4000], "url": d["url"],
                                    "license": d["license"], "quality_flags": flags.get(d["sha256"], [])}})
    return out

def _dsn(a):
    d = a.dsn or os.environ.get("SOLOB_REVIEW_DSN")
    if not d: sys.exit("DSN requis (--dsn ou SOLOB_REVIEW_DSN)")
    return d

def fetch_reviews(dsn, kind=None, language=None):
    import psycopg
    q = ("SELECT r.item_id, r.reviewer_id, r.decision, r.created_at, i.kind, i.language FROM ai_reviews r "
         "JOIN ai_review_items i ON i.item_id=r.item_id WHERE (%s::text IS NULL OR i.kind=%s) AND (%s::text IS NULL OR i.language=%s)")
    with psycopg.connect(dsn) as c:
        return [tuple(r) for r in c.execute(q, (kind, kind, language, language))]

def main(argv=None):
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    e = sp.add_parser("export-items"); e.add_argument("vdir"); e.add_argument("--out", required=True); e.add_argument("--per-lang", type=int, default=20)
    i = sp.add_parser("import-items"); i.add_argument("file"); i.add_argument("--dsn")
    r = sp.add_parser("export-reviews"); r.add_argument("--dsn"); r.add_argument("--out", required=True)
    k = sp.add_parser("kappa"); k.add_argument("--dsn"); k.add_argument("--reviews"); k.add_argument("--kind"); k.add_argument("--language")
    a = ap.parse_args(argv)
    if a.cmd == "export-items":
        items = build_items(pathlib.Path(a.vdir), a.per_lang)
        with open(a.out, "w", encoding="utf-8") as f:
            for it in items: f.write(json.dumps(it, ensure_ascii=False) + "\n")
        print(f"{len(items)} items écrits dans {a.out}")
    elif a.cmd == "import-items":
        import psycopg
        n = 0
        with psycopg.connect(_dsn(a)) as c:
            for l in open(a.file, encoding="utf-8"):
                it = json.loads(l)
                if it["kind"] not in KINDS: raise ValueError(it["kind"])
                cur = c.execute("INSERT INTO ai_review_items(item_id,kind,language,source_ref,sakc_sha256,payload) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                                (it["item_id"], it["kind"], it["language"], it["source_ref"], it.get("sakc_sha256"), json.dumps(it["payload"], ensure_ascii=False)))
                n += cur.rowcount
        print(f"{n} items importés")
    elif a.cmd == "export-reviews":
        rows = fetch_reviews(_dsn(a))
        with open(a.out, "w", encoding="utf-8") as f:
            for it, rev, dec, ts, kind, lang in rows:
                f.write(json.dumps({"item_id": it, "reviewer_id": rev, "decision": dec, "created_at": ts.isoformat(), "kind": kind, "language": lang}) + "\n")
        print(f"{len(rows)} relectures exportées")
    elif a.cmd == "kappa":
        if a.reviews:
            rows = [json.loads(l) for l in open(a.reviews, encoding="utf-8")]
            rows = [(r["item_id"], r["reviewer_id"], r["decision"], r["created_at"]) for r in rows
                    if (not a.kind or r["kind"] == a.kind) and (not a.language or r["language"] == a.language)]
        else:
            rows = [x[:4] for x in fetch_reviews(_dsn(a), a.kind, a.language)]
        x, y = pairs_from_reviews(rows); kap = cohen_kappa(x, y)
        print(json.dumps({"items_double_relus": len(x), "kappa": None if kap is None else round(kap, 4), "interpretation": interpret(None if kap is None else round(kap, 4))}, ensure_ascii=False))

if __name__ == "__main__":
    main()
