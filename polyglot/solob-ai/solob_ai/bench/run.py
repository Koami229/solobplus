"""Harnais du SOLOB Educational Benchmark.

  python -m solob_ai.bench.run --provider v0 --ckpt artifacts/run_cpu_v0/last.pt --tokenizer artifacts/toklab/unigram_8000.model
  python -m solob_ai.bench.run --provider command --cmd ./mon_modele ...
  --publish : refuse (code 2) tant qu'un item évalué n'est pas status=validated avec >= 2 relecteurs,
              ou que la piste « qualité d'explication » n'a pas de notes humaines (--human-grades).
Sans --publish, tout résultat porte le libellé « NON PUBLIABLE »."""
from __future__ import annotations
import argparse, json, pathlib, sys, time, hashlib, statistics
from .schema import load_items, validate, TRACKS
from .metrics import score_item

NP = "NON PUBLIABLE"

def build_prompt(it):
    if it["track"] == "fidelite_source":
        lab = ("Texte", "Question", "Réponse") if it["language"] == "fr" else ("Text", "Question", "Answer")
        return f"{lab[0]} : {it['passage']}\n{lab[1]} : {it['question']}\n{it.get('instruction','')}\n{lab[2]} :"
    lab = ("Question", "Réponse") if it["language"] == "fr" else ("Question", "Answer")
    return f"{lab[0]} : {it['question']}\n{lab[1]} :"

def publishability(items, human_grades):
    reasons = []
    if not items: reasons.append("aucun item évaluable")
    drafts = [i["item_id"] for i in items if i["status"] != "validated" or len(set(i["reviewer_ids"])) < 2]
    if drafts: reasons.append(f"{len(drafts)}/{len(items)} items non validés (status=draft ou < 2 relecteurs)")
    if any(i["track"] == "qualite_explication" for i in items) and not human_grades:
        reasons.append("qualité d'explication: score automatique = proxy, notes humaines requises")
    machine = [i for i in items if i["author"] == "machine-draft" and len(set(i["reviewer_ids"])) < 2]
    if machine: reasons.append(f"{len(machine)} items rédigés par machine sans double relecture")
    return (not reasons), reasons

def run(items, provider, human_grades=None, tracks=None, langs=None):
    errs = {i["item_id"]: validate(i) for i in items if validate(i)}
    if errs: raise ValueError(f"items invalides: {errs}")
    skipped = [i for i in items if i["needs_native_speaker"]]
    ev = [i for i in items if not i["needs_native_speaker"] and (not tracks or i["track"] in tracks) and (not langs or i["language"] in langs)]
    ok, reasons = publishability(ev, human_grades)
    rows, t0 = [], time.time()
    for it in ev:
        pred = provider.answer(build_prompt(it), it["language"])
        s = score_item(it, pred)
        if it["track"] == "qualite_explication" and human_grades and it["item_id"] in human_grades:
            s = {"score": human_grades[it["item_id"]], "proxy": False, "auto_proxy": s["score"]}
        rows.append({"item_id": it["item_id"], "track": it["track"], "language": it["language"], "status": it["status"],
                     "prediction": pred, **s})
    agg = {}
    for r in rows:
        agg.setdefault(r["track"], {}).setdefault(r["language"], []).append(r["score"])
    summary = {t: {l: {"n": len(v), "score_moyen": round(statistics.mean(v), 4)} for l, v in d.items()} for t, d in agg.items()}
    label = "PUBLIABLE" if ok else NP
    return {"benchmark": "SOLOB Educational Benchmark", "version": "v0-draft", "publication": label, "raisons": reasons,
            "provider": provider.describe(), "items_evalues": len(rows), "items_non_traduits_ignores": len(skipped),
            "items_sha256": hashlib.sha256(json.dumps(sorted(i["item_id"] + i["status"] for i in ev)).encode()).hexdigest(),
            "duree_s": round(time.time() - t0, 2), "resultats": {t: {"publication": label, "metrique": TRACKS[t], "par_langue": v} for t, v in summary.items()},
            "details": rows}

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", default="bench/items"); ap.add_argument("--provider", choices=["v0", "command"], required=True)
    ap.add_argument("--ckpt"); ap.add_argument("--tokenizer"); ap.add_argument("--cmd", nargs="+")
    ap.add_argument("--human-grades"); ap.add_argument("--tracks", nargs="*"); ap.add_argument("--langs", nargs="*")
    ap.add_argument("--out"); ap.add_argument("--publish", action="store_true")
    a = ap.parse_args(argv)
    items = load_items(a.items)
    hg = None
    if a.human_grades:
        hg = {}
        for l in open(a.human_grades, encoding="utf-8"):
            g = json.loads(l); hg.setdefault(g["item_id"], []).append(g["score"])
        hg = {k: statistics.mean(v) for k, v in hg.items()}
    ev = [i for i in items if not i["needs_native_speaker"] and (not a.tracks or i["track"] in a.tracks) and (not a.langs or i["language"] in a.langs)]
    ok, reasons = publishability(ev, hg)
    if a.publish and not ok:
        print(json.dumps({"publication": "REFUSÉE", "raisons": reasons}, ensure_ascii=False, indent=1), file=sys.stderr); return 2
    if a.provider == "v0":
        from .providers import V0Checkpoint; p = V0Checkpoint(a.ckpt, a.tokenizer)
    else:
        from .providers import CommandProvider; p = CommandProvider(a.cmd)
    res = run(items, p, hg, a.tracks, a.langs)
    if a.out:
        pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    short = {k: v for k, v in res.items() if k != "details"}
    print(json.dumps(short, ensure_ascii=False, indent=1)); return 0

if __name__ == "__main__":
    sys.exit(main())
