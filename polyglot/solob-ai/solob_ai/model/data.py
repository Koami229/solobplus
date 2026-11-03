"""Préparation: tokenise chaque split SAKC en tableaux uint16 par langue (<lang_x> doc <eos>)."""
from __future__ import annotations
import json, pathlib, numpy as np, torch, argparse

def prepare(corpus: pathlib.Path, tok_path: pathlib.Path, out: pathlib.Path, max_chars_per_lang: int = 10**9):
    import sentencepiece as spm
    sp = spm.SentencePieceProcessor(model_file=str(tok_path)); out.mkdir(parents=True, exist_ok=True)
    eos = sp.eos_id(); stats = {}
    for split in ("train", "val", "test"):
        per = {}; used = {}
        for line in open(corpus / f"{split}.jsonl", encoding="utf-8"):
            d = json.loads(line); l = d["language"]
            if used.get(l, 0) >= max_chars_per_lang: continue
            used[l] = used.get(l, 0) + len(d["text"])
            per.setdefault(l, []).extend([sp.piece_to_id(f"<lang_{l}>")] + sp.encode(d["text"]) + [eos])
        for l, ids in per.items():
            np.save(out / f"{split}_{l}.npy", np.array(ids, dtype=np.uint16))
        stats[split] = {l: len(v) for l, v in per.items()}
    meta = {"tokenizer": str(tok_path), "vocab_size": sp.get_piece_size(), "tokens": stats}
    (out / "meta.json").write_text(json.dumps(meta, indent=1)); return meta

class Batches:
    """Échantillonneur de fenêtres aléatoires reproductible; son état est sauvegardé dans le checkpoint."""
    def __init__(self, arrays: list[np.ndarray], seq_len: int, batch: int, seed: int):
        self.data = torch.from_numpy(np.concatenate(arrays).astype(np.int64)); self.T, self.B = seq_len, batch
        self.g = torch.Generator().manual_seed(seed)
    def next(self):
        ix = torch.randint(0, len(self.data) - self.T - 1, (self.B,), generator=self.g)
        x = torch.stack([self.data[i:i + self.T] for i in ix]); y = torch.stack([self.data[i + 1:i + 1 + self.T] for i in ix])
        return x, y
    def state(self): return self.g.get_state()
    def load_state(self, s): self.g.set_state(s)

def load_split(data_dir: pathlib.Path, split: str, lang: str | None = None) -> list[np.ndarray]:
    pat = f"{split}_{lang}.npy" if lang else f"{split}_*.npy"
    return [np.load(p) for p in sorted(data_dir.glob(pat))]

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--corpus", default="data/sakc/v0")
    ap.add_argument("--tokenizer", required=True); ap.add_argument("--out", default="artifacts/data")
    a = ap.parse_args(); print(json.dumps(prepare(pathlib.Path(a.corpus), pathlib.Path(a.tokenizer), pathlib.Path(a.out)), indent=1))
