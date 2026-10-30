"""Pipeline SAKC: extraction -> nettoyage NFC -> QC -> doublons exacts + MinHash -> porte des droits
-> découpage déterministe train/val/test sans fuite -> versionnement + journal de traçabilité."""
from __future__ import annotations
import hashlib, json, re, unicodedata, pathlib, datetime
from collections import Counter
from datasketch import MinHash, MinHashLSH
from .schema import Resource, RightsStatus

SECTION = re.compile(r"^\s*=+\s*[^=]+?\s*=+\s*$", re.M)

def clean(text: str) -> str:
    t = unicodedata.normalize("NFC", text)
    t = SECTION.sub("", t)
    t = t.replace("\u00a0", " ").replace("\u200b", "")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()

def quality(text: str, min_chars: int = 200) -> tuple[bool, str]:
    if len(text) < min_chars: return False, "trop_court"
    letters = sum(c.isalpha() for c in text)
    if letters / max(1, len(text)) < 0.6: return False, "ratio_lettres_faible"
    lines = [l for l in text.splitlines() if l.strip()]
    if lines and Counter(lines).most_common(1)[0][1] / len(lines) > 0.3 and len(lines) > 5:
        return False, "lignes_repetees"
    return True, "ok"

def shingles(text: str, k: int = 5):
    w = text.lower().split()
    return {" ".join(w[i:i + k]) for i in range(max(1, len(w) - k + 1))}

def minhash(text: str, num_perm: int = 64) -> MinHash:
    m = MinHash(num_perm=num_perm, seed=1)
    for s in shingles(text): m.update(s.encode("utf-8"))
    return m

def split_of(key: str, val: float = 0.05, test: float = 0.05) -> str:
    """Découpage déterministe par hachage stable de la clé (pas d'aléa, pas de dépendance à l'ordre)."""
    h = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "test" if h < test else "val" if h < test + val else "train"

class Trace:
    def __init__(self, path: pathlib.Path | None):
        self.path, self.events = path, []
    def log(self, event: str, **kw):
        e = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "event": event, **kw}
        self.events.append(e)
        if self.path:
            with open(self.path, "a", encoding="utf-8") as f: f.write(json.dumps(e, ensure_ascii=False) + "\n")

def run(resources: list[Resource], out_dir: pathlib.Path | None, version: str = "v0",
        near_dup_threshold: float = 0.8, trace_path: pathlib.Path | None = None) -> dict:
    trace = Trace(trace_path)
    lsh = MinHashLSH(threshold=near_dup_threshold, num_perm=64)
    seen_sha: dict[str, str] = {}
    splits: dict[str, list[Resource]] = {"train": [], "val": [], "test": []}
    stats = Counter()
    for r in resources:
        errs = r.validate()
        if errs:
            stats["schema_invalide"] += 1; trace.log("rejet_schema", id=r.resource_id, errs=errs); continue
        if r.rights_status != RightsStatus.VERIFIED:   # PORTE DES DROITS
            stats["bloque_droits"] += 1
            trace.log("bloque_droits", id=r.resource_id, url=r.url, status=r.rights_status.value); continue
        r.text = clean(r.text); r.finalize(); r.version = version
        ok, why = quality(r.text)
        if not ok:
            stats["qc_" + why] += 1; trace.log("rejet_qc", id=r.resource_id, reason=why); continue
        if r.sha256 in seen_sha:
            stats["doublon_exact"] += 1; trace.log("doublon_exact", id=r.resource_id, of=seen_sha[r.sha256]); continue
        mh = minhash(r.text)
        near = lsh.query(mh)
        if near:
            stats["quasi_doublon"] += 1; trace.log("quasi_doublon", id=r.resource_id, of=near[0]); continue
        lsh.insert(r.resource_id, mh); seen_sha[r.sha256] = r.resource_id
        s = split_of(r.sha256)
        splits[s].append(r); stats[f"{s}_{r.language}"] += 1
        trace.log("accepte", id=r.resource_id, split=s, sha256=r.sha256, lang=r.language)
    manifest = {"version": version, "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "near_dup_threshold": near_dup_threshold, "stats": dict(stats), "shards": {}}
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        for s, rs in splits.items():
            p = out_dir / f"{s}.jsonl"
            with open(p, "w", encoding="utf-8") as f:
                for r in rs: f.write(json.dumps(r.to_dict(), ensure_ascii=False) + "\n")
            manifest["shards"][s] = {"file": p.name, "docs": len(rs),
                                     "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    manifest["_splits"] = splits
    return manifest
