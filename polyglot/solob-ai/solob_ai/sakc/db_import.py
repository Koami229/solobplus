"""A01 — import SAKC en base avec porte des droits.
Toute ressource dont les droits ne sont pas établis (statut ≠ rights_verified, licence non ouverte, preuve absente,
ou source non vérifiée en base) est REFUSÉE : elle n'est pas insérée et le refus est journalisé dans
sakc_import_refusals (ajout seul, migration 010) et sakc_trace_events (event='import_refused').
Les refus sont écrits sur une connexion autocommit séparée : un échec de l'import n'efface pas la trace."""
from __future__ import annotations
import json
from .schema import OPEN_LICENSES, Resource, RightsStatus

def refusal_reason(r: Resource, source_verified: bool) -> str | None:
    if r.rights_status != RightsStatus.VERIFIED: return f"droits non établis ({r.rights_status.value})"
    if r.license not in OPEN_LICENSES: return f"licence {r.license} non ouverte"
    if not r.proof_ref: return "preuve de licence manquante"
    if not source_verified: return f"source {r.source_id} non vérifiée en base"
    errs = r.validate()
    return "; ".join(errs) if errs else None

def import_resources(dsn: str, resources: list[Resource], version: str, split: str = "train") -> dict:
    import psycopg
    stats = {"imported": 0, "refused": 0, "duplicates": 0}
    with psycopg.connect(dsn, autocommit=True) as log, psycopg.connect(dsn) as c:
        c.execute("INSERT INTO sakc_corpus_versions(version, manifest) VALUES (%s, %s::jsonb) ON CONFLICT DO NOTHING", (version, json.dumps({"source": "db_import"})))
        verified = {row[0] for row in c.execute("SELECT source_id FROM sakc_sources WHERE rights_status='rights_verified'")}
        for r in resources:
            if not r.sha256: r.finalize()
            why = refusal_reason(r, r.source_id in verified)
            if why:
                stats["refused"] += 1
                log.execute("INSERT INTO sakc_import_refusals(resource_id,url,rights_status,reason) VALUES (%s,%s,%s,%s)",
                            (r.resource_id, r.url, r.rights_status.value, why))
                log.execute("INSERT INTO sakc_trace_events(version,resource_id,event,details) VALUES (%s,%s,'import_refused',%s::jsonb)",
                            (version, r.resource_id, json.dumps({"reason": why, "url": r.url})))
                continue
            cur = c.execute("""INSERT INTO sakc_resources(resource_id,source_id,url,license,rights_status,proof_ref,country,language,
                               discipline,level,title,sha256,version,split,annotation) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                               ON CONFLICT DO NOTHING""",
                            (r.resource_id, r.source_id, r.url, r.license, r.rights_status.value, r.proof_ref, r.country, r.language,
                             r.discipline, r.level, r.title, r.sha256, version, split, json.dumps(r.annotation)))
            if cur.rowcount == 1:
                stats["imported"] += 1
                c.execute("INSERT INTO sakc_trace_events(version,resource_id,event,details) VALUES (%s,%s,'imported',%s::jsonb)",
                          (version, r.resource_id, json.dumps({"split": split})))
            else: stats["duplicates"] += 1
        c.commit()
    return stats
