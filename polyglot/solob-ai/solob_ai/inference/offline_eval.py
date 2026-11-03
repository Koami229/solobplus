"""Validation HORS LIGNE du prototype pour le futur fournisseur `solob-local` — aucun serveur.
Simule le contrat que School appliquerait: budget de délai, limite de tokens, gestion d'erreurs,
et produit un enregistrement au format des journaux d'usage (sans texte utilisateur: confidentialité)."""
from __future__ import annotations
import argparse, json, time, hashlib, pathlib, torch
import sentencepiece as spm
from ..model.config import ModelConfig
from ..model.gpt import GPT

def generate(ckpt, tok, prompt, lang, max_new=40, timeout_s=5.0, seed=0):
    t0 = time.time(); rec = {"provider": "solob-local", "status": "ok", "error": None}
    try:
        s = torch.load(ckpt, weights_only=False); m = GPT(ModelConfig(**s["cfg"]["model"])); m.load_state_dict(s["model"]); m.eval()
        sp = spm.SentencePieceProcessor(model_file=str(tok)); torch.manual_seed(seed)
        ids = [sp.piece_to_id(f"<lang_{lang}>")] + sp.encode(prompt); x = torch.tensor([ids])
        out_ids = []
        for _ in range(max_new):
            if time.time() - t0 > timeout_s: rec["status"] = "timeout"; break
            x = m.generate(x, 1, temperature=0.8); out_ids.append(x[0, -1].item())
            if out_ids[-1] == sp.eos_id(): break
        text = sp.decode(out_ids)
    except Exception as e:
        text, rec["status"], rec["error"] = "", "error", type(e).__name__
    rec.update(prompt_tokens=len(prompt), completion_tokens=len(out_ids) if rec["status"] != "error" else 0,
               latency_ms=round(1000 * (time.time() - t0)), prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest())
    return text, rec

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--ckpt", required=True); ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--prompt", default="Le Bénin est"); ap.add_argument("--lang", default="fr"); a = ap.parse_args()
    t, r = generate(a.ckpt, a.tokenizer, a.prompt, a.lang); print(json.dumps({"text": t, "usage_record": r}, ensure_ascii=False, indent=1))
