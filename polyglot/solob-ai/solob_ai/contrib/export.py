"""Export des contributions utilisateurs vers SAKC (JSONL), derrière une porte des droits.

Seules sortent les contributions de la vue `contributions_exportable` (migration 006) ET qui repassent
`rights_ok` en Python (défense en profondeur) : approuvée, item validé, CC BY 4.0, consentement connu
et horodaté, accord parental pour un mineur, aucun signalement ouvert/retenu, >= 2 validateurs distincts
autres que l'auteur. Lecture seule : ce script ne modifie pas la base.

Usage : python -m solob_ai.contrib.export --dsn postgres://... --out contributions.jsonl
"""
from __future__ import annotations
import argparse, hashlib, json, os, sys

LICENSE = "CC-BY-4.0"
QUERY = """SELECT e.contribution_id, e.kind, e.language, e.source_text, e.body, e.body_sha256, e.license, e.attribution,
       e.consent_version, e.consent_at, e.provenance, e.review_item_id, e.distinct_accepts,
       c.status, c.is_minor, c.parental_consent_at, i.status AS item_status,
       (SELECT COUNT(*) FROM contribution_reports p WHERE p.contribution_id=c.contribution_id AND p.status IN ('open','upheld')) AS blocking_reports
FROM contributions_exportable e JOIN contributions c USING (contribution_id) JOIN ai_review_items i ON i.item_id = e.review_item_id
ORDER BY e.created_at, e.contribution_id"""

def rights_ok(r: dict) -> tuple[bool, str]:
    """Pure re-verification of the rights gate; returns (ok, reason)."""
    if r.get("status") != "approved": return False, "not_approved"
    if r.get("item_status") != "validated": return False, "not_validated"
    if r.get("license") != LICENSE: return False, "license"
    if not r.get("consent_version") or not r.get("consent_at"): return False, "no_consent"
    if r.get("is_minor") and not r.get("parental_consent_at"): return False, "no_parental_consent"
    if (r.get("blocking_reports") or 0) > 0: return False, "reported"
    if (r.get("distinct_accepts") or 0) < 2: return False, "single_validation"
    body = r.get("body") or ""
    if hashlib.sha256(body.encode()).hexdigest() != r.get("body_sha256"): return False, "hash_mismatch"
    return True, "ok"

def to_record(r: dict) -> dict:
    ca = r["consent_at"]
    return {"id": f"contrib:{r['contribution_id']}", "kind": r["kind"], "language": r["language"],
            "source_text": r.get("source_text"), "text": r["body"], "sha256": r["body_sha256"],
            "license": r["license"], "attribution": r["attribution"],
            "rights": {"consent_version": r["consent_version"], "consent_at": ca.isoformat() if hasattr(ca, "isoformat") else str(ca),
                       "double_validated": True, "distinct_accepts": r["distinct_accepts"], "review_item_id": r["review_item_id"]},
            "provenance": r.get("provenance") or {}}

def select(rows: list[dict]) -> tuple[list[dict], dict[str, int]]:
    out, skipped = [], {}
    for r in rows:
        ok, why = rights_ok(r)
        if ok: out.append(to_record(r))
        else: skipped[why] = skipped.get(why, 0) + 1
    return out, skipped

def fetch(dsn: str) -> list[dict]:
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(dsn, row_factory=dict_row) as c:
        c.execute("SET TRANSACTION READ ONLY")
        return list(c.execute(QUERY))

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dsn", default=os.environ.get("SOLOB_CONTRIB_DSN"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if not a.dsn: sys.exit("DSN requis (--dsn ou SOLOB_CONTRIB_DSN)")
    recs, skipped = select(fetch(a.dsn))
    with open(a.out, "w", encoding="utf-8") as f:
        for r in recs: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"exported": len(recs), "skipped": skipped, "out": a.out}))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
