"""Registre des modèles : manifeste JSON en AJOUT SEUL (une entrée JSON par ligne, chaînée par sha256).
Aucune entrée n'est jamais réécrite ; un identifiant déjà présent est refusé. La chaîne détecte toute altération."""
from __future__ import annotations
import datetime, hashlib, json, os, pathlib
from .guard import sha256_file

def _canon(d: dict) -> str: return json.dumps(d, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

def read(path: pathlib.Path) -> list[dict]:
    if not path.exists(): return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]

def verify_chain(path: pathlib.Path) -> list[str]:
    errs, prev = [], None
    for i, e in enumerate(read(path)):
        body = {k: v for k, v in e.items() if k != "entry_sha256"}
        if e.get("prev_sha256") != prev: errs.append(f"chaine_rompue:{i}")
        if hashlib.sha256(_canon(body).encode()).hexdigest() != e.get("entry_sha256"): errs.append(f"entree_alteree:{i}")
        prev = e.get("entry_sha256")
    return errs

def hash_files(files: dict[str, str]) -> dict[str, dict]:
    return {k: {"path": p, "sha256": sha256_file(pathlib.Path(p)), "bytes": pathlib.Path(p).stat().st_size} for k, p in files.items()}

def append(path: pathlib.Path, entry: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    if errs := verify_chain(path): raise RuntimeError(f"registre altéré, ajout refusé : {errs}")
    entries = read(path)
    if any(e["id"] == entry["id"] and e.get("event") == entry.get("event") for e in entries):
        raise FileExistsError(f"entrée déjà enregistrée : {entry['id']}/{entry.get('event')} (jamais écrasée)")
    body = {**entry, "recorded_at": datetime.datetime.now().astimezone().isoformat(),
            "prev_sha256": entries[-1]["entry_sha256"] if entries else None}
    body["entry_sha256"] = hashlib.sha256(_canon(body).encode()).hexdigest()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try: os.write(fd, (json.dumps(body, ensure_ascii=False) + "\n").encode())
    finally: os.close(fd)
    return body

def current_promoted(path: pathlib.Path) -> dict | None:
    """Dernier modèle promu (événement 'promoted'), sinon None (=> la référence est la baseline de la config)."""
    prom = [e for e in read(path) if e.get("event") == "promoted"]
    return prom[-1] if prom else None
