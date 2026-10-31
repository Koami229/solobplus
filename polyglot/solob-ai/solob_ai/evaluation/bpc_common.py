"""Bits par caractère (BPC) EXACTS de plusieurs checkpoints, chacun avec SON tokenizer, sur un held-out COMMUN.
Held-out: SAKC v1 test (⊇ SAKC v0 test). Rapporte aussi le sous-ensemble « v0 test » seul.
Par langue: flux <lang_x> doc <eos> concaténé, fenêtres contiguës non chevauchantes de T tokens (dernière fenêtre partielle incluse),
BPC = somme des NLL (bits) de tous les tokens prédits / nombre de caractères (texte + 1 séparateur par doc).
Usage: python -m solob_ai.evaluation.bpc_common --model v0=artifacts/run_cpu_v0/last.pt:artifacts/toklab/unigram_8000.model --model v1=...:...
"""
from __future__ import annotations
import argparse, collections, json, math, pathlib, time
import numpy as np, sentencepiece as spm, torch
from ..model.config import ModelConfig
from ..model.gpt import GPT

def load(ckpt):
    s = torch.load(ckpt, weights_only=False); m = GPT(ModelConfig(**s["cfg"]["model"])); m.load_state_dict(s["model"]); m.eval()
    return m, s["cfg"]["model"]["max_seq_len"], s["step"]

@torch.no_grad()
def nll_bits(model, ids, T):
    x = torch.tensor(ids, dtype=torch.long); tot = 0.0; n = 0
    starts = list(range(0, len(x) - 1, T))
    for i in range(0, len(starts), 16):
        full = [st for st in starts[i:i + 16] if st + T + 1 <= len(x)]
        if full:
            xb = torch.stack([x[s:s + T] for s in full]); yb = torch.stack([x[s + 1:s + T + 1] for s in full])
            lg, _ = model(xb); tot += torch.nn.functional.cross_entropy(lg.reshape(-1, lg.size(-1)), yb.reshape(-1), reduction="sum").item(); n += yb.numel()
        for s in starts[i:i + 16]:
            if s + T + 1 > len(x):
                xb = x[s:-1].unsqueeze(0); yb = x[s + 1:].unsqueeze(0)
                lg, _ = model(xb); tot += torch.nn.functional.cross_entropy(lg.reshape(-1, lg.size(-1)), yb.reshape(-1), reduction="sum").item(); n += yb.numel()
    return tot / math.log(2), n

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--model", action="append", required=True, help="nom=ckpt:tokenizer")
    ap.add_argument("--v1test", default="data/sakc/v1/test.jsonl"); ap.add_argument("--v0test", default="data/sakc/v0/test.jsonl")
    ap.add_argument("--out"); a = ap.parse_args(); torch.set_num_threads(2)
    v0_sha = {json.loads(l)["sha256"] for l in open(a.v0test, encoding="utf-8")}
    docs = collections.defaultdict(list)
    for l in open(a.v1test, encoding="utf-8"):
        d = json.loads(l); docs[d["language"]].append((d["text"], d["sha256"] in v0_sha))
    res = {"heldout": a.v1test, "subset_v0": a.v0test, "models": {}}
    for spec in a.model:
        name, rest = spec.split("=", 1); ck, tk = rest.rsplit(":", 1); m, T, step = load(ck); sp = spm.SentencePieceProcessor(model_file=tk)
        out = {"ckpt": ck, "tokenizer": tk, "step": step, "langs": {}}; t0 = time.time()
        for lang, ds in sorted(docs.items()):
            r = {}
            for subset, keep in (("v1_test_all", lambda f: True), ("v0_test_only", lambda f: f)):
                sel = [t for t, f in ds if keep(f)]
                if not sel: continue
                ids = []; [ids.extend([sp.piece_to_id(f"<lang_{lang}>")] + sp.encode(t) + [sp.eos_id()]) for t in sel]
                bits, n = nll_bits(m, ids, T); chars = sum(len(t) + 1 for t in sel)
                r[subset] = {"docs": len(sel), "chars": chars, "tokens_predicted": n, "bpc": round(bits / chars, 4), "bits_per_token": round(bits / n, 4)}
            out["langs"][lang] = r; print(name, lang, {k: v["bpc"] for k, v in r.items()}, flush=True)
        for subset in ("v1_test_all", "v0_test_only"):
            b = sum(r[subset]["bpc"] * r[subset]["chars"] for r in out["langs"].values() if subset in r)
            c = sum(r[subset]["chars"] for r in out["langs"].values() if subset in r)
            out[f"{subset}_bpc_micro"] = round(b / c, 4)
            out[f"{subset}_bpc_macro"] = round(np.mean([r[subset]["bpc"] for r in out["langs"].values() if subset in r]), 4)
        out["seconds"] = round(time.time() - t0, 1); res["models"][name] = out
    s = json.dumps(res, indent=1, ensure_ascii=False); print(s)
    if a.out: pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True); pathlib.Path(a.out).write_text(s)

if __name__ == "__main__":
    main()
