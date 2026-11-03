"""Perplexité multilingue d'un checkpoint sur les splits val/test de SAKC, par langue.
Évaluation exhaustive par fenêtres contiguës non chevauchantes (déterministe).
Rapporte aussi les bits par caractère (comparables entre tokenizers, contrairement à la perplexité par token)."""
from __future__ import annotations
import argparse, json, math, pathlib, numpy as np, torch
from ..model.config import Config
from ..model.gpt import GPT

@torch.no_grad()
def ppl(model, arr: np.ndarray, T: int, max_windows: int = 400):
    model.eval(); x = torch.from_numpy(arr.astype(np.int64)); n = min((len(x) - 1) // T, max_windows)
    if n == 0: return None
    tot = 0.0
    for i in range(0, n, 16):
        idx = range(i, min(n, i + 16))
        xb = torch.stack([x[j * T:(j + 1) * T] for j in idx]); yb = torch.stack([x[j * T + 1:(j + 1) * T + 1] for j in idx])
        lg, _ = model(xb); tot += torch.nn.functional.cross_entropy(lg.reshape(-1, lg.size(-1)), yb.reshape(-1), reduction="sum").item()
    ntok = n * T; return {"tokens_evaluated": ntok, "loss": tot / ntok, "ppl": math.exp(tot / ntok), "nats_total": tot}

def run(ckpt: pathlib.Path, data_dir: pathlib.Path, corpus_dir: pathlib.Path | None = None):
    s = torch.load(ckpt, weights_only=False); cfg = s["cfg"]; m = GPT(Config().model.__class__(**cfg["model"]))
    m.load_state_dict(s["model"]); T = cfg["model"]["max_seq_len"]; out = {"step": s["step"], "splits": {}}
    meta = json.loads((data_dir / "meta.json").read_text())
    for split in ("val", "test"):
        for p in sorted(data_dir.glob(f"{split}_*.npy")):
            lang = p.stem.split("_", 1)[1]; arr = np.load(p); r = ppl(m, arr, T)
            if r:
                r["chars_per_token_split"] = None
                r["bits_per_char_est"] = None
                if corpus_dir:
                    ch = sum(len(json.loads(l)["text"]) for l in open(corpus_dir / f"{split}.jsonl", encoding="utf-8") if json.loads(l)["language"] == lang)
                    cpt = ch / len(arr); r["chars_per_token_split"] = round(cpt, 3)
                    r["bits_per_char_est"] = round(r["loss"] / math.log(2) / cpt, 3)
                r["loss"], r["ppl"] = round(r["loss"], 4), round(r["ppl"], 2); r.pop("nats_total")
            out["splits"].setdefault(split, {})[lang] = r
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--ckpt", required=True); ap.add_argument("--data", default="artifacts/data")
    ap.add_argument("--corpus", default="data/sakc/v0"); ap.add_argument("--out")
    a = ap.parse_args(); r = run(pathlib.Path(a.ckpt), pathlib.Path(a.data), pathlib.Path(a.corpus))
    s = json.dumps(r, indent=1, ensure_ascii=False); print(s)
    if a.out: pathlib.Path(a.out).write_text(s)
