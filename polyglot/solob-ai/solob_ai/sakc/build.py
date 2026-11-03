"""Construit SAKC vN à partir des données brutes collectées. Usage: python -m solob_ai.sakc.build"""
import argparse, json, pathlib
from .registry import load_wikipedia, write_registry
from . import pipeline

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--raw", default="data/raw/wikipedia")
    ap.add_argument("--version", default="v0"); a = ap.parse_args()
    out = pathlib.Path("data/sakc") / a.version; out.mkdir(parents=True, exist_ok=True)
    (out / "trace.jsonl").unlink(missing_ok=True)
    sources, res = load_wikipedia(pathlib.Path(a.raw))
    write_registry(sources, out / "sources.json")
    m = pipeline.run(res, out, a.version, trace_path=out / "trace.jsonl"); m.pop("_splits")
    print(json.dumps(m["stats"], indent=1, sort_keys=True))
