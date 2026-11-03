"""A01 : l'import SAKC en base refuse et journalise toute ressource sans droits établis (SAKC_TEST_PG_DSN, migrations 004+010)."""
import os, uuid, pytest
from solob_ai.sakc.schema import Resource, RightsStatus
from solob_ai.sakc.db_import import import_resources, refusal_reason

def res(status=RightsStatus.VERIFIED, lic="CC-BY-4.0", proof="proof://p1", src="t-a01", text=None):
    return Resource(source_id=src, url="https://ex.org/" + uuid.uuid4().hex, license=lic, rights_status=status, proof_ref=proof,
                    country="BJ", language="fon", text=text or uuid.uuid4().hex).finalize()

def test_refusal_reasons_pure():
    assert refusal_reason(res(), True) is None
    assert "droits non établis" in refusal_reason(res(RightsStatus.UNKNOWN), True)
    assert "droits non établis" in refusal_reason(res(RightsStatus.PENDING), True)
    assert "non ouverte" in refusal_reason(res(lic="ALL-RIGHTS-RESERVED"), True)
    assert "preuve" in refusal_reason(res(proof=""), True)
    assert "non vérifiée" in refusal_reason(res(), False)

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_db_import_refuses_and_logs_without_rights():
    import psycopg
    dsn = os.environ["SAKC_TEST_PG_DSN"]; v = "t-a01-" + uuid.uuid4().hex[:6]
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("INSERT INTO sakc_sources(source_id,name,url,license,rights_status,proof) VALUES ('t-a01','w','u','CC-BY-4.0','rights_verified','{\"a\":1}') ON CONFLICT DO NOTHING")
        c.execute("INSERT INTO sakc_sources(source_id,name,url,license,rights_status) VALUES ('t-a01-x','x','u','?','unknown') ON CONFLICT DO NOTHING")
    ok, bad1, bad2, bad3 = res(), res(RightsStatus.UNKNOWN), res(src="t-a01-x"), res(proof="")
    st = import_resources(dsn, [ok, bad1, bad2, bad3], v)
    assert st == {"imported": 1, "refused": 3, "duplicates": 0}
    with psycopg.connect(dsn) as c:
        ids = {r[0] for r in c.execute("SELECT resource_id FROM sakc_resources WHERE version=%s", (v,))}
        assert ids == {ok.resource_id}
        ref = {r[0] for r in c.execute("SELECT resource_id FROM sakc_import_refusals WHERE resource_id = ANY(%s)", ([bad1.resource_id, bad2.resource_id, bad3.resource_id],))}
        assert ref == {bad1.resource_id, bad2.resource_id, bad3.resource_id}
        assert c.execute("SELECT COUNT(*) FROM sakc_trace_events WHERE version=%s AND event='import_refused'", (v,)).fetchone()[0] == 3
    with psycopg.connect(dsn) as c, pytest.raises(psycopg.Error):
        c.execute("DELETE FROM sakc_import_refusals WHERE resource_id=%s", (bad1.resource_id,))
