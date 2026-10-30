"""Entraînement (CPU ou GPU, même code). Checkpoints complets + reprise exacte, journal des pertes JSONL,
validation périodique, perplexité, garde-fou durée et mémoire. Usage: python -m solob_ai.model.train configs/cpu.yaml"""
from __future__ import annotations
import json, math, pathlib, sys, time, random, resource
import numpy as np, torch
from .config import Config
from .gpt import GPT
from .data import Batches, load_split

def set_seed(s):
    random.seed(s); np.random.seed(s); torch.manual_seed(s)

def lr_at(step, c):
    if step < c.warmup_steps: return c.lr * (step + 1) / c.warmup_steps
    p = (step - c.warmup_steps) / max(1, c.max_steps - c.warmup_steps); return c.lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1, p))))

@torch.no_grad()
def evaluate(model, arrays, seq_len, n_batches, batch, device, seed=0):
    """Perte moyenne sur des fenêtres fixes (seed fixe => comparable entre étapes)."""
    if not arrays or sum(len(a) for a in arrays) < seq_len + 2: return None
    b = Batches(arrays, seq_len, batch, seed); model.eval(); tot = 0.0
    for _ in range(n_batches):
        x, y = b.next(); tot += model(x.to(device), y.to(device))[1].item()
    model.train(); return tot / n_batches

def save_ckpt(path, model, opt, step, batches, cfg, extra=None):
    tmp = path.with_suffix(".tmp")
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step, "batches": batches.state(),
                "torch_rng": torch.get_rng_state(), "cfg": cfg.to_dict(), **(extra or {})}, tmp); tmp.replace(path)

def train(cfg: Config, resume: bool = True, stop_at: int | None = None, log=print) -> dict:
    t = cfg.train; set_seed(t.seed); torch.set_num_threads(t.threads)
    out = pathlib.Path(t.out_dir); out.mkdir(parents=True, exist_ok=True); dd = pathlib.Path(t.data_dir)
    model = GPT(cfg.model).to(t.device)
    opt = torch.optim.AdamW(model.parameters(), lr=t.lr, betas=(0.9, 0.95), weight_decay=t.weight_decay)
    batches = Batches(load_split(dd, "train"), t.seq_len, t.batch_size, t.seed)
    val = load_split(dd, "val"); step = 0; ck = out / "last.pt"
    if resume and ck.exists():
        s = torch.load(ck, weights_only=False); model.load_state_dict(s["model"]); opt.load_state_dict(s["opt"])
        step = s["step"]; batches.load_state(s["batches"]); torch.set_rng_state(s["torch_rng"]); log(f"reprise à l'étape {step}")
    logf = open(out / "losses.jsonl", "a"); t0 = time.time(); end = stop_at or t.max_steps
    log(f"paramètres: {model.n_params():,}")
    while step < end:
        for g in opt.param_groups: g["lr"] = lr_at(step, t)
        loss_acc = 0.0
        for _ in range(t.grad_accum):
            x, y = batches.next(); loss = model(x.to(t.device), y.to(t.device))[1] / t.grad_accum; loss.backward(); loss_acc += loss.item()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); opt.zero_grad(set_to_none=True); step += 1
        rec = {"step": step, "train_loss": round(loss_acc, 4), "lr": round(opt.param_groups[0]["lr"], 6),
               "elapsed_s": round(time.time() - t0, 1), "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024}
        if step % t.eval_every == 0 or step == end:
            vl = evaluate(model, val, t.seq_len, t.eval_batches, t.batch_size, t.device)
            if vl is not None: rec.update(val_loss=round(vl, 4), val_ppl=round(math.exp(vl), 2))
            log(json.dumps(rec))
        logf.write(json.dumps(rec) + "\n"); logf.flush()
        if step % t.ckpt_every == 0 or step == end: save_ckpt(ck, model, opt, step, batches, cfg)
        if (time.time() - t0) / 60 > t.max_minutes:
            save_ckpt(ck, model, opt, step, batches, cfg); log(f"arrêt: limite de {t.max_minutes} min atteinte à l'étape {step}"); break
    return {"step": step, "model": model, "minutes": (time.time() - t0) / 60}

if __name__ == "__main__":
    cfg = Config.load(sys.argv[1]); r = train(cfg)
    print(json.dumps({"final_step": r["step"], "minutes": round(r["minutes"], 1)}))
