"""Exécute la comparaison tokenizer sur SAKC vN. Usage: python -m solob_ai.toklab.run --corpus data/sakc/v0"""
import argparse, json, pathlib, collections, time, resource
from .lab import LANGS, train_tokenizer, metrics, variant_cost

def load(p):
    by = collections.defaultdict(list)
    for l in open(p, encoding="utf-8"):
        d = json.loads(l); by[d["language"]].append(d["text"])
    return by

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--corpus", default="data/sakc/v0")
    ap.add_argument("--vocabs", default="4000,8000,16000"); ap.add_argument("--cap", type=int, default=800_000)
    ap.add_argument("--out", default="artifacts/toklab"); a = ap.parse_args()
    c = pathlib.Path(a.corpus); out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    train, test = load(c / "train.jsonl"), load(c / "test.jsonl")
    tr_texts, sizes, counts = [], {}, {}
    for l in LANGS:
        s, buf = 0, []
        for t in train.get(l, []):
            if s >= a.cap: break
            buf.append(t[: a.cap - s]); s += len(buf[-1])
        tr_texts += buf; counts[l] = collections.Counter(w for t in buf for w in t.split())
        sizes[l] = {"train_chars_used": s, "train_docs": len(train.get(l, [])), "test_chars": sum(map(len, test.get(l, []))),
                    "test_docs": len(test.get(l, []))}
    results = {"sizes": sizes, "runs": []}
    for kind in ("bpe", "unigram", "bytebpe"):
        for v in map(int, a.vocabs.split(",")):
            t0 = time.time(); tok = train_tokenizer(kind, tr_texts, v); dt = time.time() - t0
            tok.save(out / f"{kind}_{v}")
            run = {"kind": kind, "vocab_target": v, "vocab_actual": tok.vocab_size(), "train_seconds": round(dt, 1), "langs": {}}
            for l in LANGS:
                if not test.get(l): run["langs"][l] = None; continue
                m = metrics(tok, "\n".join(test[l]), counts[l]); m["variants"] = variant_cost(tok, l); run["langs"][l] = m
            for l in LANGS:
                m = run["langs"][l]
                if m: m["parity_vs_fr"] = round(m["tokens_per_1k_chars"] / run["langs"]["fr"]["tokens_per_1k_chars"], 3); \
                      m["parity_vs_en"] = round(m["tokens_per_1k_chars"] / run["langs"]["en"]["tokens_per_1k_chars"], 3)
            results["runs"].append(run); print(kind, v, tok.vocab_size(), f"{dt:.1f}s", flush=True)
    results["peak_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
