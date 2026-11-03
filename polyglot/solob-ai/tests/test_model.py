import numpy as np, torch, pathlib, math
from solob_ai.model.config import Config, ModelConfig, TrainConfig
from solob_ai.model.gpt import GPT
from solob_ai.model.train import train

TINY = dict(vocab_size=64, d_model=32, n_layers=2, n_heads=4, d_ff=64, max_seq_len=16)

def test_shapes_and_causality():
    m = GPT(ModelConfig(**TINY)); x = torch.randint(0, 64, (3, 16))
    lg, loss = m(x, x); assert lg.shape == (3, 16, 64) and loss.ndim == 0
    x2 = x.clone(); x2[:, 10:] = 0  # changer le futur ne doit pas changer les logits passés
    assert torch.allclose(m(x)[0][:, :10], m(x2)[0][:, :10], atol=1e-5)

def test_overfit_minibatch():
    torch.manual_seed(0); m = GPT(ModelConfig(**TINY)); opt = torch.optim.AdamW(m.parameters(), 3e-3)
    x = torch.randint(0, 64, (4, 16)); y = torch.roll(x, -1, 1); first = None
    for _ in range(300):
        _, l = m(x, y); opt.zero_grad(); l.backward(); opt.step(); first = first or l.item()
    assert first > 3.5 and l.item() < 0.1

def _cfg(tmp, out):
    d = tmp / "data"; d.mkdir(exist_ok=True)
    rng = np.random.default_rng(0)
    for s in ("train", "val"): np.save(d / f"{s}_fr.npy", rng.integers(0, 64, 2000).astype(np.uint16))
    return Config(ModelConfig(**TINY), TrainConfig(threads=1, seed=7, batch_size=4, seq_len=16, max_steps=20, warmup_steps=5,
                  eval_every=10, eval_batches=2, ckpt_every=5, out_dir=str(tmp / out), data_dir=str(d)))

def test_resume_identical(tmp_path):
    a = train(_cfg(tmp_path, "a"), log=lambda *_: None)["model"]
    c = _cfg(tmp_path, "b"); train(c, stop_at=10, log=lambda *_: None)
    b = train(c, resume=True, log=lambda *_: None)["model"]
    for (n, p), (_, q) in zip(a.state_dict().items(), b.state_dict().items()):
        assert torch.equal(p, q), n
    lines = (tmp_path / "b" / "losses.jsonl").read_text().splitlines(); assert len(lines) == 20
