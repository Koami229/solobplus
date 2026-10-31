"""Pont benchmark <-> système de relecture (/review, migration 005).

  python -m solob_ai.bench.export to-review  --items bench/items --out data/bench/review_items.jsonl
      -> puis: python -m solob_ai.review.cli import-items data/bench/review_items.jsonl
  python -m solob_ai.bench.export sync-status --items bench/items [--dsn ... | SOLOB_REVIEW_DSN]
      -> met status=validated + reviewer_ids pour les items validés en base (double relecture 'accept')."""
from __future__ import annotations
import argparse, json, os, pathlib
from .schema import load_items

KIND = {"qualite_explication": "explanation"}

def to_review(items):
    out = []
    for it in items:
        kind = "translation" if it["needs_native_speaker"] else KIND.get(it["track"], "question")
        out.append({"item_id": f"bench:{it['item_id']}", "kind": kind, "language": it["language"],
                    "source_ref": f"bench:v0-draft:{it['item_id']}", "sakc_sha256": None,
                    "payload": {"benchmark": "SOLOB Educational Benchmark", "track": it["track"], "country": it["country"],
                                "level": it["level"], "question": it["question"], "reference": it["reference"],
                                "accepted": it.get("accepted", []), "passage": it.get("passage"), "rubric": it.get("rubric"),
                                "expected_behavior": it.get("expected_behavior"), "translate_from": it.get("translate_from"),
                                "author": it["author"], "license": it["license"], "notes": it.get("notes")}})
    return out

def apply_validations(items, validated: dict[str, list[str]]):
    """validated: {bench_item_id: [reviewer_ids]} — ne valide que si >= 2 relecteurs distincts. Les items à traduire restent draft."""
    n = 0
    for it in items:
        r = sorted(set(validated.get(it["item_id"], [])))
        if len(r) >= 2 and not it["needs_native_speaker"]:
            it["status"], it["reviewer_ids"] = "validated", r; n += 1
    return n

def fetch_validated(dsn):
    import psycopg
    q = """SELECT i.item_id, array_agg(DISTINCT r.reviewer_id::text) FROM ai_review_items i JOIN ai_reviews r USING (item_id)
           WHERE i.status='validated' AND i.item_id LIKE 'bench:%%' AND r.decision='accept' GROUP BY 1"""
    with psycopg.connect(dsn) as c:
        return {k.removeprefix("bench:"): v for k, v in c.execute(q).fetchall()}

def main(argv=None):
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("to-review"); a1.add_argument("--items", default="bench/items"); a1.add_argument("--out", required=True)
    a2 = sub.add_parser("sync-status"); a2.add_argument("--items", default="bench/items"); a2.add_argument("--dsn")
    a = ap.parse_args(argv); items = load_items(a.items)
    if a.cmd == "to-review":
        pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as f:
            for r in to_review(items): f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"{len(items)} items exportés vers {a.out}")
    else:
        dsn = a.dsn or os.environ.get("SOLOB_REVIEW_DSN")
        if not dsn: raise SystemExit("DSN requis (--dsn ou SOLOB_REVIEW_DSN)")
        n = apply_validations(items, fetch_validated(dsn))
        by = {}
        for i in items: by.setdefault(i["track"], []).append(i)
        for t, lst in by.items():
            with open(pathlib.Path(a.items) / f"{t}.jsonl", "w", encoding="utf-8") as f:
                for i in lst: f.write(json.dumps(i, ensure_ascii=False) + "\n")
        print(f"{n} items passés en validated")

if __name__ == "__main__":
    main()
