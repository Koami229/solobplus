"""Pilote de réentraînement piloté par configuration (même code CPU local / GPU cloud ; seul le YAML change).

Étapes : vérif. intégrité v0/v1 -> jetons parent (lecture seule) + deltas v1.N tokenisés avec le tokenizer FIGÉ ->
poids de mélange par température -> entraînement (initialisé depuis un checkpoint en lecture seule, ou de zéro) ->
checkpoint candidat dans un répertoire NEUF -> audit d'usage des contributions (+ used_in_training_at via la fonction
SQL de la migration 007 si un DSN est fourni) -> entrée « trained » au registre.
Ne promeut rien : la promotion est décidée par solob_ai.pipeline.promote.
Usage : python -m solob_ai.pipeline.retrain configs/retrain_smoke.yaml
"""
from __future__ import annotations
import contextlib, dataclasses, datetime, json, math, os, pathlib, random, resource, sys, time
import numpy as np, torch, yaml
from ..model.config import ModelConfig, TrainConfig, Config
from ..model.gpt import GPT
from ..model.train import lr_at
from . import registry
from .guard import assert_not_protected, sha256_file, verify
from .mix import temperature_weights, effective_epochs

@dataclasses.dataclass
class RetrainConfig:
    run_id: str
    parent_tokens: str                      # répertoire de jetons parent (lecture seule), ex. artifacts/data_v1
    tokenizer: str                          # tokenizer figé (jamais réentraîné ici)
    sakc: str = "data/sakc"
    deltas: list = dataclasses.field(default_factory=list)   # versions v1.N à inclure
    init_from: str | None = None            # checkpoint initial (lecture seule)
    mix: dict = dataclasses.field(default_factory=lambda: {"temperature": 3.0, "floor": 0.0, "cap": 1.0})
    registry: str = "artifacts/registry/models.jsonl"
    audit: str = "artifacts/registry/training_audit.jsonl"
    dsn_env: str = "SOLOB_CONTRIB_DSN"      # si défini dans l'environnement : marquage used_in_training_at en base
    verify_baselines: bool = True
    model: dict = dataclasses.field(default_factory=dict)
    train: dict = dataclasses.field(default_factory=dict)

    @staticmethod
    def load(path: str) -> "RetrainConfig":
        return RetrainConfig(**yaml.safe_load(open(path)))

class MixedBatches:
    """Échantillonneur reproductible : langue tirée selon les poids de mélange, puis fenêtre aléatoire dans son flux."""
    def __init__(self, streams: dict[str, np.ndarray], weights: dict[str, float], seq_len: int, batch: int, seed: int):
        self.langs = sorted(weights); self.T, self.B = seq_len, batch
        self.data = {l: torch.from_numpy(streams[l].astype(np.int64)) for l in self.langs}
        for l in self.langs:
            if len(self.data[l]) < seq_len + 2: raise ValueError(f"flux trop court pour {l}")
        self.p = torch.tensor([weights[l] for l in self.langs], dtype=torch.float64)
        self.g = torch.Generator().manual_seed(seed); self.counts = {l: 0 for l in self.langs}
    def next(self):
        li = torch.multinomial(self.p, self.B, replacement=True, generator=self.g).tolist(); xs, ys = [], []
        for k in li:
            l = self.langs[k]; d = self.data[l]; self.counts[l] += 1
            i = int(torch.randint(0, len(d) - self.T - 1, (1,), generator=self.g))
            xs.append(d[i:i + self.T]); ys.append(d[i + 1:i + 1 + self.T])
        return torch.stack(xs), torch.stack(ys)

def delta_records(sakc: pathlib.Path, versions: list[str]) -> list[dict]:
    out = []
    for v in versions:
        m = json.loads((sakc / v / "MANIFEST.json").read_text())
        if m.get("files", {}).get("contributions.jsonl") != sha256_file(sakc / v / "contributions.jsonl"):
            raise RuntimeError(f"{v}: contributions.jsonl ne correspond pas à son manifeste")
        for l in open(sakc / v / "contributions.jsonl", encoding="utf-8"):
            d = json.loads(l)
            if d["exclude_from_training"] or d.get("rights_status") != "rights_verified" or d.get("license") != "CC-BY-4.0": continue
            out.append(d)
    return out

def build_streams(cfg: RetrainConfig, deltas: list[dict], max_tokens_per_lang: int | None) -> dict[str, dict[str, np.ndarray]]:
    pt = pathlib.Path(cfg.parent_tokens); streams = {"train": {}, "val": {}}
    for split in streams:
        for p in sorted(pt.glob(f"{split}_*.npy")):
            a = np.load(p, mmap_mode="r"); a = a[:max_tokens_per_lang] if max_tokens_per_lang else a
            streams[split][p.stem.split("_", 1)[1]] = np.asarray(a)
    if deltas:
        import sentencepiece as spm
        sp = spm.SentencePieceProcessor(model_file=cfg.tokenizer); per = {}
        for d in deltas:
            per.setdefault(d["language"], []).extend([sp.piece_to_id(f"<lang_{d['language']}>")] + sp.encode(d["text"]) + [sp.eos_id()])
        for l, ids in per.items():
            streams["train"][l] = np.concatenate([streams["train"].get(l, np.zeros(0, np.uint16)), np.array(ids, np.uint16)])
    return streams

@torch.no_grad()
def val_loss(model, streams, T, n, B, device):
    if not streams: return None
    arr = np.concatenate([streams[l] for l in sorted(streams)]).astype(np.int64)
    if len(arr) < T + 2: return None
    g = torch.Generator().manual_seed(0); d = torch.from_numpy(arr); model.eval(); tot = 0.0
    for _ in range(n):
        ix = torch.randint(0, len(d) - T - 1, (B,), generator=g)
        x = torch.stack([d[i:i + T] for i in ix]).to(device); y = torch.stack([d[i + 1:i + 1 + T] for i in ix]).to(device)
        tot += model(x, y)[1].item()
    model.train(); return tot / n

def record_training_use(cfg: RetrainConfig, deltas: list[dict], ckpt_sha: str, steps: int) -> dict:
    """Appelé UNIQUEMENT après un entraînement réel (>= 1 pas d'optimisation). Audit en ajout seul + base si DSN."""
    ids = sorted({d["id"].split(":", 1)[1] for d in deltas if d["id"].startswith("contrib:")})
    ev = {"ts": datetime.datetime.now().astimezone().isoformat(), "event": "contributions_used_in_training",
          "run_id": cfg.run_id, "steps": steps, "checkpoint_sha256": ckpt_sha, "contribution_ids": ids,
          "db_marked": None}
    dsn = os.environ.get(cfg.dsn_env)
    if ids and dsn:
        import psycopg
        with psycopg.connect(dsn) as c:
            ev["db_marked"] = c.execute("SELECT ai_mark_contributions_trained(%s, %s, %s)", (cfg.run_id, ids, ckpt_sha)).fetchone()[0]
    elif ids: ev["db_marked"] = "skipped:no_dsn"
    p = pathlib.Path(cfg.audit); p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f: f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return ev

def retrain(cfg: RetrainConfig, root: pathlib.Path = pathlib.Path("."), log=print, config_path: str | None = None) -> dict:
    if cfg.verify_baselines:
        for b in ("v0", "v1"):
            m = root / f"baselines/{b}-manifest.json"
            if m.exists() and (bad := verify(m, root)): raise RuntimeError(f"baseline {b} altérée ou absente : {bad[:5]}")
    t = TrainConfig(**cfg.train); out = pathlib.Path(t.out_dir)
    assert_not_protected(out, root)
    if out.exists(): raise FileExistsError(f"{out} existe déjà : un candidat n'est jamais écrasé")
    init = None
    if cfg.init_from:
        init = torch.load(cfg.init_from, weights_only=False, map_location="cpu"); mc = ModelConfig(**init["cfg"]["model"])
    else: mc = ModelConfig(**cfg.model)
    random.seed(t.seed); np.random.seed(t.seed); torch.manual_seed(t.seed); torch.set_num_threads(t.threads)
    deltas = delta_records(pathlib.Path(cfg.sakc), cfg.deltas)
    streams = build_streams(cfg, deltas, cfg.mix.get("max_tokens_per_lang"))
    sizes = {l: len(a) for l, a in streams["train"].items()}
    w = temperature_weights(sizes, cfg.mix.get("temperature", 3.0), cfg.mix.get("floor", 0.0), cfg.mix.get("cap", 1.0))
    natural = {l: round(n / sum(sizes.values()), 6) for l, n in sizes.items()}
    log(json.dumps({"mix_natural": natural, "mix_weights": w}))
    model = GPT(mc).to(t.device)
    if init: model.load_state_dict(init["model"]); del init
    opt = torch.optim.AdamW(model.parameters(), lr=t.lr, betas=(0.9, 0.95), weight_decay=t.weight_decay)
    run_model = torch.compile(model) if t.compile else model
    amp = torch.autocast("cuda", dtype=torch.bfloat16) if t.device == "cuda" and t.dtype == "bfloat16" else contextlib.nullcontext()
    batches = MixedBatches(streams["train"], w, t.seq_len, t.batch_size, t.seed)
    out.mkdir(parents=True); logf = open(out / "losses.jsonl", "a"); t0 = time.time(); step = 0; vl = None
    v0 = val_loss(model, streams["val"], t.seq_len, t.eval_batches, t.batch_size, t.device)
    log(json.dumps({"step": 0, "val_loss": v0 and round(v0, 4)}))
    while step < t.max_steps:
        for g in opt.param_groups: g["lr"] = lr_at(step, t)
        acc = 0.0
        for _ in range(t.grad_accum):
            x, y = batches.next()
            with amp: loss = run_model(x.to(t.device), y.to(t.device))[1] / t.grad_accum
            loss.backward(); acc += loss.item()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); opt.zero_grad(set_to_none=True); step += 1
        rec = {"step": step, "train_loss": round(acc, 4), "lr": round(opt.param_groups[0]["lr"], 6), "elapsed_s": round(time.time() - t0, 1),
               "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024}
        if step % t.eval_every == 0 or step == t.max_steps:
            vl = val_loss(model, streams["val"], t.seq_len, t.eval_batches, t.batch_size, t.device)
            if vl is not None: rec.update(val_loss=round(vl, 4), val_ppl=round(math.exp(vl), 2))
            log(json.dumps(rec))
        logf.write(json.dumps(rec) + "\n"); logf.flush()
        if (time.time() - t0) / 60 > t.max_minutes: log(f"arrêt : limite de {t.max_minutes} min à l'étape {step}"); break
    logf.close()
    if step == 0: raise RuntimeError("aucun pas d'entraînement : rien n'est enregistré")
    ck = out / "last.pt"
    full = Config(mc, t).to_dict()
    torch.save({"model": model.state_dict(), "step": step, "cfg": full, "run_id": cfg.run_id, "init_from": cfg.init_from,
                "mix_weights": w}, ck)
    ck_sha = sha256_file(ck)
    tokens_seen = step * t.batch_size * t.grad_accum * t.seq_len
    summary = {"run_id": cfg.run_id, "steps": step, "minutes": round((time.time() - t0) / 60, 2), "val_loss_start": v0 and round(v0, 4),
               "val_loss_end": vl and round(vl, 4), "params": model.n_params(), "mix_natural": natural, "mix_weights": w,
               "lang_sample_counts": batches.counts, "effective_epochs": effective_epochs(sizes, w, tokens_seen),
               "delta_versions": cfg.deltas, "contributions_used": len(deltas), "tokens_seen": tokens_seen}
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    summary["audit"] = record_training_use(cfg, deltas, ck_sha, step)
    files = {"checkpoint": str(ck), "tokenizer": cfg.tokenizer}
    if config_path: files["config"] = config_path
    if cfg.init_from: files["init_from"] = cfg.init_from
    for v in cfg.deltas: files[f"delta_{v}"] = str(pathlib.Path(cfg.sakc) / v / "MANIFEST.json")
    registry.append(pathlib.Path(cfg.registry), {"id": cfg.run_id, "event": "trained", "files": registry.hash_files(files),
                    "train_config": full, "mix_weights": w, "steps": step, "val_loss_end": summary["val_loss_end"],
                    "contributions_used": len(deltas), "note": "candidat NON promu ; voir promote.py"})
    return summary

def main(argv=None) -> int:
    a = (argv or sys.argv[1:]); cfg = RetrainConfig.load(a[0])
    s = retrain(cfg, config_path=a[0]); s.pop("audit", None); print(json.dumps(s, indent=1)); return 0

if __name__ == "__main__":
    sys.exit(main())
