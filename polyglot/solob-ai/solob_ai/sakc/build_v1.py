"""Construit SAKC v1 = v0 + sources Mission 3. Usage: python -m solob_ai.sakc.build_v1
v0 n'est pas modifié (lecture seule de data/sakc/v0). Sortie: data/sakc/v1/."""
import json, pathlib, hashlib
from collections import Counter
from . import pipeline, collect_v1 as C
from .registry import load_wikipedia

AFROLID = {"fon": {"fon"}, "yo": {"yor"}, "ha": {"hau"}, "wo": {"wol"}, "sw": {"swh", "swa", "swc"}, "ig": {"ibo"}}
EVAL_ONLY_SOURCES = {"flores-plus"}

def langid_filter(res, stats, model_dir="artifacts/afrolid/afrolid_1.5"):
    import torch; torch.set_num_threads(6)
    from transformers import pipeline as hfp
    clf = hfp("text-classification", model=model_dir, use_fast=False, device=-1)
    keep, todo = [], [r for r in res if r.language in AFROLID]
    keep += [r for r in res if r.language not in AFROLID]   # AfroLID ne couvre pas fr/en
    texts = [r.text[:1000] for r in todo]
    preds = clf(texts, batch_size=16, truncation=True, max_length=256, top_k=1)
    for r, p in zip(todo, preds):
        p = p[0] if isinstance(p, list) else p
        r.annotation.setdefault("labels", {})["afrolid"] = {"label": p["label"], "score": round(p["score"], 4)}
        if p["label"] in AFROLID[r.language]: keep.append(r)
        else: stats[f"langid_mismatch_{r.source_id}_{r.language}"] += 1
    return keep

if __name__ == "__main__":
    R = pathlib.Path("data/raw"); out = pathlib.Path("data/sakc/v1"); out.mkdir(parents=True, exist_ok=True)
    (out / "trace.jsonl").unlink(missing_ok=True)
    pre = Counter()
    v0 = C.load_v0(pathlib.Path("data/sakc/v0"))
    new = C.load_asb(R / "asb", pre) + C.load_smol(R / "smol", pre) + C.load_cv(R / "commonvoice", pre) \
        + C.load_wikibooks(R / "wikibooks", pre)
    pre.update({f"charge_{r.source_id}": 1 for r in []})
    for r in new: pre[f"charge_{r.source_id}_{r.language}"] += 1
    gated = [r for r in new if r.rights_status.value != "rights_verified"]
    verified = [r for r in new if r.rights_status.value == "rights_verified"]
    verified = langid_filter(verified, pre)
    m = pipeline.run(v0 + gated + verified, out, "v1", trace_path=out / "trace.jsonl")
    splits = m.pop("_splits")
    # v0 doit rester dans les mêmes splits
    v0_split = {}
    for s in ("train", "val", "test"):
        for line in open(f"data/sakc/v0/{s}.jsonl", encoding="utf-8"): v0_split[json.loads(line)["resource_id"]] = s
    moved = sum(1 for s, rs in splits.items() for r in rs if r.resource_id in v0_split and v0_split[r.resource_id] != s)
    lost = len(v0_split) - sum(1 for rs in splits.values() for r in rs if r.resource_id in v0_split)
    # fuite éval-only
    leak = sum(1 for rs in splits.values() for r in rs if r.source_id in EVAL_ONLY_SOURCES)
    # sous-ensemble éducatif
    edu = {s: [r for r in rs if r.annotation.get("labels", {}).get("educational")] for s, rs in splits.items()}
    with open(out / "educational.jsonl", "w", encoding="utf-8") as f:
        for s, rs in edu.items():
            for r in rs: f.write(json.dumps({"split": s, **r.to_dict()}, ensure_ascii=False) + "\n")
    chars = Counter(); docs = Counter()
    for s, rs in splits.items():
        for r in rs: chars[(r.source_id, r.language, s)] += len(r.text); docs[(r.source_id, r.language, s)] += 1
    report = {"preload": dict(pre), "pipeline": m["stats"], "v0_moved_split": moved, "v0_lost": lost,
              "eval_only_leak": leak, "flores": "bloque (gated, 401)",
              "chars": [[*k, v, docs[k]] for k, v in sorted(chars.items())],
              "educational_docs": {s: len(v) for s, v in edu.items()},
              "educational_sha256": hashlib.sha256((out / "educational.jsonl").read_bytes()).hexdigest()}
    (out / "BUILD_REPORT.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "chars"}, indent=1, ensure_ascii=False))
