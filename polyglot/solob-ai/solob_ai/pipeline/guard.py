"""Garde-fous d'intégrité : v0 (baselines/v0-manifest.json) et v1 (baselines/v1-manifest.json) ne doivent JAMAIS changer.
Vérification par sha256 ; aucune écriture sur les chemins protégés. Usage : python -m solob_ai.pipeline.guard [--freeze-v1]"""
from __future__ import annotations
import argparse, datetime, hashlib, json, pathlib, sys

V1_PATHS = ["data/sakc/v1", "data/sakc/v1_train_filtered", "artifacts/data_v1", "artifacts/toklab_v1",
            "artifacts/run_cpu_v1", "artifacts/eval_v1", "configs/cpu_v1.yaml"]

def sha256_file(p: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

def verify(manifest: pathlib.Path, root: pathlib.Path = pathlib.Path(".")) -> list[str]:
    """Retourne la liste des écarts (vide = intact). Un fichier absent localement est un écart."""
    bad = []
    for f in json.loads(manifest.read_text())["files"]:
        p = root / f["path"]
        if not p.exists(): bad.append(f"absent:{f['path']}")
        elif sha256_file(p) != f["sha256"]: bad.append(f"modifie:{f['path']}")
    return bad

def protected_paths(root: pathlib.Path, manifests: list[pathlib.Path]) -> set[pathlib.Path]:
    out = set()
    for m in manifests:
        if m.exists():
            for f in json.loads(m.read_text())["files"]: out.add((root / f["path"]).resolve())
    return out

def assert_not_protected(target: pathlib.Path, root: pathlib.Path = pathlib.Path(".")) -> None:
    """Refuse toute écriture dans un chemin protégé (v0/v1) ou dans un répertoire qui en contient."""
    t = target.resolve()
    for p in protected_paths(root, [root / "baselines/v0-manifest.json", root / "baselines/v1-manifest.json"]):
        if t == p or t in p.parents: raise PermissionError(f"chemin protégé (v0/v1) : {target}")
    for v in V1_PATHS + ["data/sakc/v0", "artifacts/data", "artifacts/toklab", "artifacts/run_cpu_v0"]:
        pv = (root / v).resolve()
        if t == pv or pv in t.parents: raise PermissionError(f"chemin protégé (v0/v1) : {target}")

def freeze_v1(root: pathlib.Path, out: pathlib.Path) -> dict:
    if out.exists(): raise FileExistsError(f"{out} existe déjà : un gel ne s'écrase jamais")
    files = []
    for v in V1_PATHS:
        p = root / v; it = [p] if p.is_file() else sorted(x for x in p.rglob("*") if x.is_file()) if p.exists() else []
        for x in it: files.append({"path": str(x.relative_to(root)), "bytes": x.stat().st_size, "sha256": sha256_file(x)})
    m = {"baseline": "v1", "frozen_at": datetime.datetime.now().astimezone().isoformat(),
         "note": "Gel par hachage seulement (Phase D) ; artefacts non déplacés ni modifiés. artifacts/ et data/ sont locaux (gitignore).",
         "files": files}
    out.write_text(json.dumps(m, indent=1)); return m

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--freeze-v1", action="store_true"); a = ap.parse_args(argv)
    root = pathlib.Path(".")
    if a.freeze_v1: print(len(freeze_v1(root, root / "baselines/v1-manifest.json")["files"]), "fichiers v1 gelés")
    res = {m: verify(root / f"baselines/{m}-manifest.json") for m in ("v0", "v1") if (root / f"baselines/{m}-manifest.json").exists()}
    print(json.dumps(res, indent=1)); return 1 if any(res.values()) else 0

if __name__ == "__main__":
    sys.exit(main())
