from __future__ import annotations
from dataclasses import dataclass, asdict, field
import yaml

@dataclass
class ModelConfig:
    vocab_size: int = 8000
    d_model: int = 192
    n_layers: int = 4
    n_heads: int = 4
    d_ff: int = 768
    max_seq_len: int = 256
    dropout: float = 0.0
    tie_embeddings: bool = True

@dataclass
class TrainConfig:
    device: str = "cpu"            # "cpu" | "cuda" — seul changement nécessaire pour passer au GPU
    dtype: str = "float32"         # "bfloat16" sur GPU
    threads: int = 6
    seed: int = 1234
    batch_size: int = 16
    grad_accum: int = 1
    seq_len: int = 256
    lr: float = 1e-3
    warmup_steps: int = 100
    max_steps: int = 2000
    max_minutes: float = 55.0
    weight_decay: float = 0.1
    eval_every: int = 200
    eval_batches: int = 20
    ckpt_every: int = 200
    out_dir: str = "artifacts/run"
    data_dir: str = "artifacts/data"
    compile: bool = False

@dataclass
class Config:
    model: ModelConfig = field(default_factory=ModelConfig)
    train: TrainConfig = field(default_factory=TrainConfig)

    @staticmethod
    def load(path: str) -> "Config":
        d = yaml.safe_load(open(path)) or {}
        return Config(ModelConfig(**d.get("model", {})), TrainConfig(**d.get("train", {})))

    def to_dict(self): return {"model": asdict(self.model), "train": asdict(self.train)}
