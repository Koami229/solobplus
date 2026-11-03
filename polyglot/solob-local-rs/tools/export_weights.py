"""Export du checkpoint SOLOB AI promu (PyTorch) vers safetensors pour solob-local (Rust/candle).

LECTURE SEULE des originaux : le checkpoint, le tokenizer et le registre ne sont jamais modifiés (ouverts en lecture,
empreintes SHA-256 vérifiées contre le registre append-only). Sortie dans un NOUVEAU dossier :
  model.safetensors   poids float32 (head.weight omis: liée à tok.weight, comme dans le modèle PyTorch)
  config.json         ModelConfig + métadonnées (id, provenance, sha256 des sources)
  tokenizer.model     copie octet pour octet du tokenizer SentencePiece
  parity.safetensors  logits PyTorch de référence sur des prompts fixes (test de parité Rust)
  parity.json         prompts, ids de tokens, continuation gloutonne PyTorch
  manifest.json       sha256 de chaque fichier exporté (vérifié au chargement par solob-local)

Usage :
  python tools/export_weights.py --ai-root ../solob-ai --out ../solob-ai/artifacts/solob-local/promoted
  python tools/export_weights.py --random-init --out /tmp/solob-local-fixture   # CI: modèle aléatoire minuscule
"""
from __future__ import annotations
import argparse, hashlib, json, pathlib, shutil, sys

PROMPTS = [("fr", "Le Bénin est un pays"), ("en", "The water cycle"), ("fon", "Mi kudo"), ("sw", "Elimu ni"),
           ("yo", "Ẹ kú àárọ̀"), ("fr", "2 + 2 =")]
GREEDY_STEPS = 12

def sha256(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

def promoted(ai_root: pathlib.Path) -> dict:
    reg = ai_root / "artifacts/registry/models.jsonl"
    rows = [json.loads(l) for l in reg.read_text(encoding="utf-8").splitlines() if l.strip()]
    pro = [r for r in rows if r.get("event") == "promoted"]
    if not pro: sys.exit("aucun modèle promu dans le registre")
    r = pro[-1]
    for k in ("checkpoint", "tokenizer"):
        f = r["files"][k]; p = ai_root / f["path"]
        if sha256(p) != f["sha256"]: sys.exit(f"empreinte {k} différente du registre: {p}")
    return r

def random_fixture(out: pathlib.Path, seed: int):
    """Modèle + tokenizer minuscules, aléatoires, pour la CI (aucune donnée réelle, aucun artefact non versionné)."""
    import io, sentencepiece as spm, torch
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "solob-ai"))
    from solob_ai.model.config import ModelConfig
    from solob_ai.model.gpt import GPT
    text = ["Le Bénin est un pays d'Afrique de l'Ouest.", "The water cycle moves water.", "Mi kudo, a fɔn ganji à?",
            "Elimu ni ufunguo wa maisha.", "Ẹ kú àárọ̀, ẹ ṣé.", "2 + 2 = 4 et 3 + 3 = 6."] * 50
    buf = io.BytesIO()
    spm.SentencePieceTrainer.train(sentence_iterator=iter(text), model_writer=buf, vocab_size=120, model_type="unigram",
                                   character_coverage=1.0, user_defined_symbols=[f"<lang_{l}>" for l in ("fr", "en", "fon", "sw", "yo")],
                                   eos_id=2, bos_id=-1, pad_id=-1, unk_id=0, hard_vocab_limit=False)
    tok = out / "tokenizer.model"; tok.write_bytes(buf.getvalue())
    sp = spm.SentencePieceProcessor(model_file=str(tok))
    torch.manual_seed(seed)
    cfg = ModelConfig(vocab_size=sp.get_piece_size(), d_model=32, n_layers=2, n_heads=4, d_ff=64, max_seq_len=24)
    m = GPT(cfg)
    with torch.no_grad():  # LayerNorm non triviales pour que la parité teste aussi gamma/beta
        for n, p in m.named_parameters():
            if n.endswith(("n1.weight", "n2.weight", "norm.weight")): p.add_(0.1 * torch.randn_like(p))
            if n.endswith(("n1.bias", "n2.bias", "norm.bias")): p.add_(0.1 * torch.randn_like(p))
    return m, cfg, sp, {"id": "ci-random-init", "kind": "random-init (CI only, not a trained model)", "seed": seed}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ai-root", default=str(pathlib.Path(__file__).resolve().parents[2] / "solob-ai"))
    ap.add_argument("--out", required=True); ap.add_argument("--random-init", action="store_true"); ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    import torch, sentencepiece as spm
    from safetensors.torch import save_file
    out = pathlib.Path(a.out)
    if out.exists() and any(out.iterdir()): sys.exit(f"refus d'écraser un dossier non vide: {out}")
    out.mkdir(parents=True, exist_ok=True)
    if a.random_init:
        m, cfg, sp, meta = random_fixture(out, a.seed)
    else:
        ai = pathlib.Path(a.ai_root); sys.path.insert(0, str(ai))
        from solob_ai.model.config import ModelConfig
        from solob_ai.model.gpt import GPT
        r = promoted(ai)
        ck = ai / r["files"]["checkpoint"]["path"]; tk = ai / r["files"]["tokenizer"]["path"]
        s = torch.load(ck, map_location="cpu", weights_only=False)
        cfg = ModelConfig(**s["cfg"]["model"]); m = GPT(cfg); m.load_state_dict(s["model"])
        shutil.copyfile(tk, out / "tokenizer.model"); sp = spm.SentencePieceProcessor(model_file=str(out / "tokenizer.model"))
        meta = {"id": r["id"], "kind": "promoted checkpoint (experimental, ~%.1fM params)" % (m.n_params() / 1e6),
                "registry_entry_sha256": r.get("entry_sha256"), "source_checkpoint_sha256": r["files"]["checkpoint"]["sha256"],
                "source_tokenizer_sha256": r["files"]["tokenizer"]["sha256"]}
    m.eval()
    if not cfg.tie_embeddings: sys.exit("solob-local suppose tie_embeddings=True")
    sd = {k: v.detach().contiguous().float() for k, v in m.state_dict().items() if k != "head.weight"}
    save_file(sd, str(out / "model.safetensors"))
    conf = {**{k: getattr(cfg, k) for k in ("vocab_size", "d_model", "n_layers", "n_heads", "d_ff", "max_seq_len", "tie_embeddings")},
            "layer_norm_eps": 1e-5, "eos_id": sp.eos_id(), "n_params": m.n_params(), "meta": meta}
    (out / "config.json").write_text(json.dumps(conf, indent=1, ensure_ascii=False))
    # Parité : logits complets (toutes positions) + continuation gloutonne, calculés par le modèle PyTorch d'origine.
    tensors, cases = {}, []
    with torch.no_grad():
        for i, (lang, p) in enumerate(PROMPTS):
            ids = ([sp.piece_to_id(f"<lang_{lang}>")] + sp.encode(p))[-cfg.max_seq_len:]
            lg, _ = m(torch.tensor([ids])); tensors[f"logits_{i}"] = lg[0].contiguous().float()
            x = torch.tensor([ids]); greedy = []
            for _ in range(GREEDY_STEPS):
                nxt = int(m(x[:, -cfg.max_seq_len:])[0][0, -1].argmax()); greedy.append(nxt)
                x = torch.cat([x, torch.tensor([[nxt]])], 1)
            cases.append({"lang": lang, "prompt": p, "ids": ids, "greedy": greedy})
    save_file(tensors, str(out / "parity.safetensors"))
    (out / "parity.json").write_text(json.dumps({"torch": torch.__version__, "cases": cases}, indent=1, ensure_ascii=False))
    files = {f.name: sha256(f) for f in sorted(out.iterdir()) if f.name != "manifest.json"}
    (out / "manifest.json").write_text(json.dumps({"files": files}, indent=1))
    print(json.dumps({"out": str(out), "id": meta["id"], "n_params": m.n_params(), "files": files}, indent=1))

if __name__ == "__main__":
    main()
