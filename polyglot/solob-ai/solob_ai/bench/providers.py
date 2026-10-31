"""Fournisseurs évaluables. Contrat: answer(prompt, lang) -> str. Décodage déterministe (glouton) par défaut."""
from __future__ import annotations
import subprocess

class Provider:
    name = "abstract"
    def answer(self, prompt: str, lang: str) -> str: raise NotImplementedError
    def describe(self) -> dict: return {"name": self.name}

class StaticProvider(Provider):
    """Pour les tests: renvoie une réponse fixe ou tirée d'un dict {question: réponse}."""
    name = "static"
    def __init__(self, answers=None, default=""): self.answers, self.default = answers or {}, default
    def answer(self, prompt, lang):
        for k, v in self.answers.items():
            if k in prompt: return v
        return self.default

class V0Checkpoint(Provider):
    """Prototype SOLOB AI v0 (GPT 4 couches, ~2,3 M paramètres, tokenizer unigram 8k)."""
    name = "solob-v0"
    def __init__(self, ckpt, tokenizer, max_new=32):
        import torch, sentencepiece as spm
        from ..model.config import ModelConfig
        from ..model.gpt import GPT
        s = torch.load(ckpt, weights_only=False); self.cfg = s["cfg"]; self.step = s.get("step")
        self.m = GPT(ModelConfig(**self.cfg["model"])); self.m.load_state_dict(s["model"]); self.m.eval()
        self.sp = spm.SentencePieceProcessor(model_file=str(tokenizer)); self.torch = torch; self.max_new = max_new
        self.ckpt, self.tok = str(ckpt), str(tokenizer)
    def describe(self): return {"name": self.name, "ckpt": self.ckpt, "tokenizer": self.tok, "step": self.step, "decoding": "greedy", "max_new_tokens": self.max_new}
    def answer(self, prompt, lang):
        t = self.torch; tag = self.sp.piece_to_id(f"<lang_{lang}>")
        ids = ([tag] if tag != self.sp.unk_id() else []) + self.sp.encode(prompt)
        L = self.m.c.max_seq_len; x = t.tensor([ids[-(L - self.max_new):]]); out = []
        with t.no_grad():
            for _ in range(self.max_new):
                lg, _ = self.m(x[:, -L:]); nxt = int(lg[0, -1].argmax())
                if nxt == self.sp.eos_id(): break
                out.append(nxt); x = t.cat([x, t.tensor([[nxt]])], 1)
        return self.sp.decode(out)

class CommandProvider(Provider):
    """Fournisseur générique (ex. futur solob-local): une commande locale lit le prompt sur stdin, écrit la réponse sur stdout.
    Aucun service réseau ni payant n'est appelé par le harnais lui-même."""
    name = "command"
    def __init__(self, cmd: list[str], timeout_s=30): self.cmd, self.timeout = cmd, timeout_s
    def describe(self): return {"name": self.name, "cmd": self.cmd[0]}
    def answer(self, prompt, lang):
        r = subprocess.run(self.cmd + ["--lang", lang], input=prompt, capture_output=True, text=True, timeout=self.timeout)
        return r.stdout.strip() if r.returncode == 0 else ""
