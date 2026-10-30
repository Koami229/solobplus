"""Transformer causal décodeur (style GPT, pré-normalisation), initialisé aléatoirement."""
from __future__ import annotations
import math, torch, torch.nn as nn, torch.nn.functional as F
from .config import ModelConfig

class Block(nn.Module):
    def __init__(self, c: ModelConfig):
        super().__init__()
        self.n1, self.n2 = nn.LayerNorm(c.d_model), nn.LayerNorm(c.d_model)
        self.qkv = nn.Linear(c.d_model, 3 * c.d_model, bias=False)
        self.proj = nn.Linear(c.d_model, c.d_model, bias=False)
        self.ff = nn.Sequential(nn.Linear(c.d_model, c.d_ff, bias=False), nn.GELU(), nn.Linear(c.d_ff, c.d_model, bias=False))
        self.h, self.drop = c.n_heads, c.dropout
    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(self.n1(x)).view(B, T, 3, self.h, C // self.h).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.drop if self.training else 0.0)
        x = x + self.proj(a.transpose(1, 2).reshape(B, T, C))
        return x + self.ff(self.n2(x))

class GPT(nn.Module):
    def __init__(self, c: ModelConfig):
        super().__init__(); self.c = c
        self.tok = nn.Embedding(c.vocab_size, c.d_model); self.pos = nn.Embedding(c.max_seq_len, c.d_model)
        self.blocks = nn.ModuleList(Block(c) for _ in range(c.n_layers)); self.norm = nn.LayerNorm(c.d_model)
        self.head = nn.Linear(c.d_model, c.vocab_size, bias=False)
        if c.tie_embeddings: self.head.weight = self.tok.weight
        self.apply(self._init)
        for n, p in self.named_parameters():
            if n.endswith("proj.weight") or n.endswith("ff.2.weight"): nn.init.normal_(p, 0, 0.02 / math.sqrt(2 * c.n_layers))
    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)): nn.init.normal_(m.weight, 0.0, 0.02)
    def n_params(self): return sum(p.numel() for p in self.parameters())
    def forward(self, idx, targets=None):
        B, T = idx.shape; assert T <= self.c.max_seq_len
        x = self.tok(idx) + self.pos(torch.arange(T, device=idx.device))
        for b in self.blocks: x = b(x)
        logits = self.head(self.norm(x))
        loss = None if targets is None else F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1))
        return logits, loss
    @torch.no_grad()
    def generate(self, idx, n, temperature=1.0):
        for _ in range(n):
            lg, _ = self(idx[:, -self.c.max_seq_len:]); p = F.softmax(lg[:, -1] / temperature, -1)
            idx = torch.cat([idx, torch.multinomial(p, 1)], 1)
        return idx
