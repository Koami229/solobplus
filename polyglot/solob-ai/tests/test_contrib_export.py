"""Porte des droits de l'export des contributions (migration 006) : test pur + test sur PostgreSQL (SAKC_TEST_PG_DSN)."""
import datetime as dt, hashlib, json, os, pathlib, re, uuid, pytest
from solob_ai.contrib.export import rights_ok, select, fetch, main

ROOT = pathlib.Path(__file__).resolve().parents[3] / "db"
MIG = ROOT / "migrations"; AI = ROOT / "migrations-ai"

def row(**kw):
    b = kw.pop("body", "Un texte de test en fon.")
    r = {"contribution_id": "c1", "kind": "text", "language": "fon", "source_text": None, "body": b,
         "body_sha256": hashlib.sha256(b.encode()).hexdigest(), "license": "CC-BY-4.0", "attribution": "K",
         "consent_version": "contrib-v1", "consent_at": dt.datetime(2026, 11, 2), "provenance": {"origin": "x"},
         "review_item_id": "contrib_c1", "distinct_accepts": 2, "status": "approved", "is_minor": False,
         "parental_consent_at": None, "item_status": "validated", "blocking_reports": 0}
    r.update(kw); return r

def test_006_is_additive():
    code = "\n".join(l.split("--")[0] for l in (AI / "006_contributions.sql").read_text().splitlines())
    assert not re.search(r"\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b", code, re.I)

@pytest.mark.parametrize("kw,why", [({"status": "pending"}, "not_approved"), ({"status": "withdrawn"}, "not_approved"),
    ({"item_status": "disputed"}, "not_validated"), ({"license": "CC-BY-SA-4.0"}, "license"), ({"consent_at": None}, "no_consent"),
    ({"is_minor": True}, "no_parental_consent"), ({"blocking_reports": 1}, "reported"), ({"distinct_accepts": 1}, "single_validation"),
    ({"body_sha256": "0" * 64}, "hash_mismatch")])
def test_gate_rejects(kw, why):
    assert rights_ok(row(**kw)) == (False, why)

def test_gate_accepts_and_record_has_provenance():
    recs, skipped = select([row(), row(contribution_id="c2", is_minor=True, parental_consent_at=dt.datetime(2026, 1, 1)), row(contribution_id="c3", distinct_accepts=1)])
    assert [r["id"] for r in recs] == ["contrib:c1", "contrib:c2"] and skipped == {"single_validation": 1}
    assert recs[0]["license"] == "CC-BY-4.0" and recs[0]["rights"]["double_validated"] and recs[0]["provenance"] == {"origin": "x"}

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_export_on_postgres(tmp_path):
    import psycopg
    x = uuid.uuid4().hex[:8]
    dsn = os.environ["SAKC_TEST_PG_DSN"]
    with psycopg.connect(dsn, autocommit=True) as c:
        for f in sorted(MIG.glob("00*.sql")): c.execute(f.read_text())
        for _ in range(2):
            c.execute((AI / "005_human_review.sql").read_text()); c.execute((AI / "006_contributions.sql").read_text())
        for u in ("a", "r1", "r2"):
            c.execute("INSERT INTO users(id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','n','student','school')", (f"t6{x}{u}", f"t6{x}{u}@e.org"))
        for k in ("ok", "one"):
            body = f"Texte {k} {x} pour export."
            c.execute("INSERT INTO ai_review_items(item_id,kind,language,source_ref,payload) VALUES (%s,'resource','fon','t','{}')", (f"t6{x}{k}",))
            c.execute("""INSERT INTO contributions(contribution_id,contributor_id,kind,language,body,body_sha256,attribution,consent_version,consent_at,review_item_id,provenance)
                         VALUES (%s,%s,'text','fon',%s,%s,'K','contrib-v1',NOW(),%s,'{"origin":"test"}')""",
                      (f"t6{x}{k}", f"t6{x}a", body, hashlib.sha256(body.encode()).hexdigest(), f"t6{x}{k}"))
        ins = "INSERT INTO ai_reviews(review_id,item_id,reviewer_id,decision) VALUES (%s,%s,%s,'accept')"
        with pytest.raises(psycopg.errors.RaiseException): c.execute(ins, (f"t6{x}s", f"t6{x}ok", f"t6{x}a"))
        c.execute(ins, (f"t6{x}1", f"t6{x}ok", f"t6{x}r1")); c.execute(ins, (f"t6{x}2", f"t6{x}ok", f"t6{x}r2"))
        c.execute(ins, (f"t6{x}3", f"t6{x}one", f"t6{x}r1"))
    ids = [r["contribution_id"] for r in fetch(dsn) if r["contribution_id"].startswith(f"t6{x}")]
    assert ids == [f"t6{x}ok"]
    out = tmp_path / "c.jsonl"
    assert main(["--dsn", dsn, "--out", str(out)]) == 0
    recs = [json.loads(l) for l in out.read_text().splitlines()]
    assert f"contrib:t6{x}ok" in [r["id"] for r in recs] and f"contrib:t6{x}one" not in [r["id"] for r in recs]
