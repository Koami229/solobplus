"""Porte de promotion : un candidat n'est promu que si, sur le held-out de test FIGÉ (SAKC v1 test), son BPC par langue
(bits par caractère, indépendant du tokenizer : evaluation/bpc_common) ne se dégrade de plus de `max_regression` sur
AUCUNE langue prioritaire ET si la moyenne pondérée s'améliore d'au moins `min_avg_gain`.
Écrit un rapport de promotion ; ajoute « evaluated » puis, si la porte passe, « promoted » au registre (ajout seul).
« promoted » = nouvelle référence de comparaison ; ce n'est PAS un déploiement (accord du propriétaire requis).
Les scores du benchmark éducatif restent NON PUBLIABLES tant qu'ils ne sont pas validés par des experts.
Usage : python -m solob_ai.pipeline.promote configs/promote.yaml --candidate RUN_ID
"""
from __future__ import annotations
import argparse, collections, datetime, hashlib, json, pathlib, sys
import yaml
from . import registry
from .guard import sha256_file

PRIORITY = ["fon", "yo", "ha", "wo", "ig", "sw", "fr", "en"]
PUBLICATION = "NON PUBLIABLE : scores de benchmark non validés par des experts humains ; BPC = mesure interne seulement."

def load_heldout(path: pathlib.Path, max_docs_per_lang: int | None = None) -> dict[str, list[str]]:
    docs = collections.defaultdict(list)
    for l in open(path, encoding="utf-8"):
        d = json.loads(l)
        if max_docs_per_lang is None or len(docs[d["language"]]) < max_docs_per_lang: docs[d["language"]].append(d["text"])
    return dict(docs)

def bpc_per_lang(ckpt: str, tokenizer: str, docs: dict[str, list[str]], threads: int = 4) -> dict[str, dict]:
    import sentencepiece as spm, torch
    from ..evaluation.bpc_common import load, nll_bits
    torch.set_num_threads(threads); m, T, _ = load(ckpt); sp = spm.SentencePieceProcessor(model_file=tokenizer); out = {}
    for lang, texts in sorted(docs.items()):
        ids = []
        for t in texts: ids.extend([sp.piece_to_id(f"<lang_{lang}>")] + sp.encode(t) + [sp.eos_id()])
        bits, n = nll_bits(m, ids, T); chars = sum(len(t) + 1 for t in texts)
        out[lang] = {"docs": len(texts), "chars": chars, "bpc": round(bits / chars, 4)}
    return out

def decide(inc: dict[str, float], cand: dict[str, float], priority: list[str], max_regression: float = 0.02,
           min_avg_gain: float = 0.0, weights: dict[str, float] | None = None) -> dict:
    """Décision pure. BPC plus bas = meilleur. delta = candidat - référence (positif = régression)."""
    langs = sorted(set(inc) & set(cand)); missing = [l for l in priority if l not in langs]
    w = {l: (weights or {}).get(l, 1.0) for l in langs}
    delta = {l: round(cand[l] - inc[l], 4) for l in langs}
    regress = {l: delta[l] for l in priority if l in delta and delta[l] > max_regression}
    avg = lambda d: sum(w[l] * d[l] for l in langs) / sum(w.values())
    a_inc, a_cand = round(avg(inc), 4), round(avg(cand), 4); gain = round(a_inc - a_cand, 4)
    reasons = []
    if missing: reasons.append(f"langues prioritaires absentes du held-out : {missing}")
    if regress: reasons.append(f"régression > {max_regression} BPC : {regress}")
    if gain <= min_avg_gain: reasons.append(f"moyenne pondérée non améliorée (gain {gain} <= {min_avg_gain})")
    return {"promote": not reasons, "reasons": reasons or ["toutes les conditions sont remplies"], "delta_bpc": delta,
            "weighted_avg_incumbent": a_inc, "weighted_avg_candidate": a_cand, "weighted_avg_gain": gain,
            "max_regression": max_regression, "min_avg_gain": min_avg_gain, "priority": priority, "weights": w}

def run(cfg: dict, candidate_id: str, scorer=bpc_per_lang) -> dict:
    reg = pathlib.Path(cfg.get("registry", "artifacts/registry/models.jsonl"))
    if errs := registry.verify_chain(reg): raise RuntimeError(f"registre altéré : {errs}")
    entries = registry.read(reg)
    cand = next((e for e in entries if e["id"] == candidate_id and e["event"] == "trained"), None)
    if not cand: raise KeyError(f"candidat inconnu au registre : {candidate_id}")
    if any(e["id"] == candidate_id and e["event"] in ("evaluated", "promoted") for e in entries):
        raise FileExistsError(f"{candidate_id} déjà évalué : une décision n'est jamais réécrite")
    for k, f in cand["files"].items():
        if k in ("checkpoint", "tokenizer") and sha256_file(pathlib.Path(f["path"])) != f["sha256"]: raise RuntimeError(f"{k} du candidat modifié")
    cur = registry.current_promoted(reg)
    inc = ({"id": cur["id"], "checkpoint": cur["files"]["checkpoint"]["path"], "tokenizer": cur["files"]["tokenizer"]["path"]}
           if cur else {"id": cfg["baseline"]["id"], "checkpoint": cfg["baseline"]["checkpoint"], "tokenizer": cfg["baseline"]["tokenizer"]})
    held = pathlib.Path(cfg["heldout"]); held_sha = sha256_file(held)
    if cfg.get("heldout_sha256") and cfg["heldout_sha256"] != held_sha: raise RuntimeError("held-out modifié : comparaison refusée")
    docs = load_heldout(held, cfg.get("max_docs_per_lang"))
    s_inc = scorer(inc["checkpoint"], inc["tokenizer"], docs); s_cand = scorer(cand["files"]["checkpoint"]["path"], cand["files"]["tokenizer"]["path"], docs)
    g = cfg.get("gate", {})
    dec = decide({l: v["bpc"] for l, v in s_inc.items()}, {l: v["bpc"] for l, v in s_cand.items()}, g.get("priority", PRIORITY),
                 g.get("max_regression", 0.02), g.get("min_avg_gain", 0.0), g.get("weights"))
    report = {"candidate": candidate_id, "incumbent": inc, "decided_at": datetime.datetime.now().astimezone().isoformat(),
              "heldout": {"path": str(held), "sha256": held_sha, "max_docs_per_lang": cfg.get("max_docs_per_lang"),
                          "docs": {l: len(t) for l, t in docs.items()}, "note": "held-out figé ; jamais utilisé à l'entraînement"},
              "metric": "BPC (bits/caractère), plus bas = meilleur, comparable entre tokenizers",
              "bpc_incumbent": s_inc, "bpc_candidate": s_cand, "decision": dec, "publication": PUBLICATION,
              "deployment": "aucun : la mise en production exige l'accord explicite du propriétaire",
              "mastery_claim": "aucune : un BPC plus bas ne signifie pas qu'une langue est maîtrisée"}
    out = pathlib.Path(cfg.get("reports_dir", "artifacts/registry/reports")) / f"promotion_{candidate_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists(): raise FileExistsError(f"{out} existe déjà")
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    rep_sha = sha256_file(out)
    registry.append(reg, {"id": candidate_id, "event": "evaluated", "promote": dec["promote"], "incumbent": inc["id"],
                          "report": {"path": str(out), "sha256": rep_sha}, "weighted_avg_gain": dec["weighted_avg_gain"],
                          "publication": PUBLICATION})
    if dec["promote"]:
        registry.append(reg, {"id": candidate_id, "event": "promoted", "files": {k: cand["files"][k] for k in ("checkpoint", "tokenizer")},
                              "replaces": inc["id"], "report": {"path": str(out), "sha256": rep_sha},
                              "deployment": "non déployé ; accord du propriétaire requis"})
    report["report_path"] = str(out); return report

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("config"); ap.add_argument("--candidate", required=True); a = ap.parse_args(argv)
    r = run(yaml.safe_load(open(a.config)), a.candidate)
    print(json.dumps({"candidate": r["candidate"], "incumbent": r["incumbent"]["id"], **{k: r["decision"][k] for k in ("promote", "reasons", "delta_bpc", "weighted_avg_gain")},
                      "report": r["report_path"], "publication": PUBLICATION}, indent=1, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
