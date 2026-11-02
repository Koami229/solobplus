"""Ingestion des contributions validées (export solob_ai.contrib.export) dans une NOUVELLE version SAKC v1.N (delta additif).

- Porte des droits revérifiée sur chaque enregistrement : un enregistrement refusé n'entre jamais dans le corpus
  (seuls son id et la raison sont journalisés, pas son texte).
- Drapeaux qualité (sakc.quality.checks + sakc.pipeline.quality) : drapeaux SEULEMENT, rien n'est supprimé.
- Déduplication exacte (sha256) + MinHash contre tout le SAKC existant (v1 train/val/test + deltas v1.x antérieurs) :
  un quasi-doublon est conservé mais marqué `exclude_from_training` (évite aussi la fuite du test figé).
- Toutes les contributions vont dans le split train : le held-out de test v1 reste FIGÉ.
- Jamais d'écriture dans v0/v1 ; un répertoire de version existant n'est jamais écrasé (création atomique).
Usage : python -m solob_ai.pipeline.ingest --export contributions.jsonl [--sakc data/sakc] [--parent v1]
"""
from __future__ import annotations
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, sys, tempfile
from datasketch import MinHashLSH
from ..sakc.pipeline import clean, minhash, quality
from ..sakc.quality import checks
from .guard import assert_not_protected, sha256_file

LANGS = {"fon", "yo", "ha", "wo", "ig", "sw", "fr", "en"}
LICENSE = "CC-BY-4.0"
VERSION_RE = re.compile(r"^v1\.(\d+)$")

def rights_reason(r: dict) -> str:
    """Revérification pure (défense en profondeur) du format produit par contrib.export.to_record."""
    rt = r.get("rights") or {}
    if r.get("license") != LICENSE: return "license"
    if r.get("language") not in LANGS: return "language"
    if not rt.get("consent_version") or not rt.get("consent_at"): return "no_consent"
    if not rt.get("double_validated") or (rt.get("distinct_accepts") or 0) < 2: return "single_validation"
    if not str(r.get("id", "")).startswith("contrib:"): return "bad_id"
    if not r.get("attribution"): return "no_attribution"
    if hashlib.sha256((r.get("text") or "").encode()).hexdigest() != r.get("sha256"): return "hash_mismatch"
    return "ok"

def quality_flags(text: str, lang: str) -> list[str]:
    f = []
    ok, why = quality(text, min_chars=40)
    if not ok: f.append(f"qc:{why}")
    f += checks.repetition_flags(text) + checks.script_flags(text, lang) + checks.orthography_flags(text, lang)
    return sorted(set(f))

def existing_versions(sakc: pathlib.Path) -> list[str]:
    return sorted((p.name for p in sakc.iterdir() if p.is_dir() and VERSION_RE.match(p.name)), key=lambda n: int(n.split(".")[1]))

def next_version(sakc: pathlib.Path) -> str:
    v = existing_versions(sakc); return f"v1.{int(v[-1].split('.')[1]) + 1 if v else 1}"

def iter_existing(sakc: pathlib.Path, parent: str):
    for split in ("train", "val", "test"):
        p = sakc / parent / f"{split}.jsonl"
        if p.exists():
            for l in open(p, encoding="utf-8"):
                d = json.loads(l); yield f"{parent}:{split}", d["sha256"], d["text"]
    for v in existing_versions(sakc):
        p = sakc / v / "contributions.jsonl"
        if p.exists():
            for l in open(p, encoding="utf-8"):
                d = json.loads(l); yield f"{v}:train", d["sha256"], d["text"]

def ingest(export: pathlib.Path, sakc: pathlib.Path, parent: str = "v1", version: str | None = None,
           threshold: float = 0.8, root: pathlib.Path = pathlib.Path(".")) -> dict:
    version = version or next_version(sakc)
    if not VERSION_RE.match(version): raise ValueError("version attendue : v1.N")
    out = sakc / version
    if out.exists(): raise FileExistsError(f"{out} existe déjà : une version n'est jamais écrasée")
    assert_not_protected(out, root)
    parent_manifest = sakc / parent / "MANIFEST.json"
    lsh = MinHashLSH(threshold=threshold, num_perm=64); seen: dict[str, str] = {}; n_ref = 0
    for where, sha, text in iter_existing(sakc, parent):
        seen.setdefault(sha, where); key = f"{where}#{n_ref}"; lsh.insert(key, minhash(text)); n_ref += 1
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    kept, rejected, trace = [], [], []; stats = {"input": 0, "rights_rejected": {}, "kept": 0, "excluded_from_training": 0, "by_language": {}}
    for line in open(export, encoding="utf-8"):
        if not line.strip(): continue
        r = json.loads(line); stats["input"] += 1
        why = rights_reason(r)
        if why != "ok":
            stats["rights_rejected"][why] = stats["rights_rejected"].get(why, 0) + 1
            rejected.append({"id": r.get("id"), "reason": why}); trace.append({"ts": now, "event": "rights_rejected", "id": r.get("id"), "reason": why}); continue
        text = clean(r["text"]); lang = r["language"]; sha = hashlib.sha256(text.encode()).hexdigest()
        flags = quality_flags(text, lang); dup = None
        if sha in seen: dup = f"exact:{seen[sha]}"
        else:
            hits = lsh.query(m := minhash(text))
            if hits: dup = f"near:{sorted(hits)[0].split('#')[0]}"
        if dup: flags.append(f"dup:{dup}")
        excl = dup is not None
        rec = {**{k: r.get(k) for k in ("id", "kind", "language", "source_text", "license", "attribution", "rights", "provenance")},
               "text": text, "sha256": sha, "original_sha256": r["sha256"], "split": "train", "version": version,
               "source_id": "solob-contributions", "rights_status": "rights_verified", "quality_flags": sorted(flags),
               "exclude_from_training": excl, "ingested_at": now}
        kept.append(rec); stats["kept"] += 1; stats["excluded_from_training"] += excl
        stats["by_language"][lang] = stats["by_language"].get(lang, 0) + (0 if excl else 1)
        if not dup: seen[sha] = f"{version}:train"; lsh.insert(f"{version}:train#{len(kept)}", m)
        trace.append({"ts": now, "event": "ingested", "id": rec["id"], "sha256": sha, "flags": rec["quality_flags"], "exclude_from_training": excl})
    manifest = {"version": version, "kind": "delta", "parent": parent,
                "parent_manifest_sha256": sha256_file(parent_manifest) if parent_manifest.exists() else None,
                "created_at": now, "input_export": str(export), "input_export_sha256": sha256_file(export),
                "near_dup_threshold": threshold, "reference_docs": n_ref, "heldout": f"{parent}/test.jsonl (figé, inchangé)",
                "stats": stats, "policy": "rights gate re-checked; quality = flags only; near-dups kept but excluded from training; all in train split"}
    tmp = pathlib.Path(tempfile.mkdtemp(prefix=f".{version}.", dir=sakc))
    try:
        with open(tmp / "contributions.jsonl", "w", encoding="utf-8") as f:
            for r in kept: f.write(json.dumps(r, ensure_ascii=False) + "\n")
        with open(tmp / "rejected.jsonl", "w", encoding="utf-8") as f:
            for r in rejected: f.write(json.dumps(r) + "\n")
        with open(tmp / "trace.jsonl", "w", encoding="utf-8") as f:
            for e in trace: f.write(json.dumps(e, ensure_ascii=False) + "\n")
        manifest["files"] = {n: sha256_file(tmp / n) for n in ("contributions.jsonl", "rejected.jsonl", "trace.jsonl")}
        (tmp / "MANIFEST.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
        os.rename(tmp, out)  # échoue si `out` est apparu entre-temps (pas d'écrasement)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True); raise
    return manifest

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Ingestion des contributions en SAKC v1.N")
    ap.add_argument("--export", required=True); ap.add_argument("--sakc", default="data/sakc"); ap.add_argument("--parent", default="v1")
    ap.add_argument("--version"); ap.add_argument("--threshold", type=float, default=0.8); a = ap.parse_args(argv)
    m = ingest(pathlib.Path(a.export), pathlib.Path(a.sakc), a.parent, a.version, a.threshold)
    print(json.dumps({k: m[k] for k in ("version", "parent", "stats")}, ensure_ascii=False)); return 0

if __name__ == "__main__":
    sys.exit(main())
