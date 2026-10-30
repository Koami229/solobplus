"""Migration 004 sur un vrai PostgreSQL: définir SAKC_TEST_PG_DSN (base jetable), sinon test ignoré."""
import os, pathlib, re, pytest
MIG = pathlib.Path(__file__).resolve().parents[3] / "db" / "migrations"

def test_004_is_additive():
    sql = (MIG / "004_sakc.sql").read_text()
    code = "\n".join(l.split("--")[0] for l in sql.splitlines())
    assert not re.search(r"\b(DROP|TRUNCATE|DELETE|ALTER\s+TABLE\s+(?!sakc_))\b", code, re.I)

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_004_applies_twice_and_enforces_rights_gate():
    import psycopg
    with psycopg.connect(os.environ["SAKC_TEST_PG_DSN"], autocommit=True) as c:
        for f in sorted(MIG.glob("00*.sql")): c.execute(f.read_text())
        c.execute((MIG / "004_sakc.sql").read_text())  # idempotente
        c.execute("insert into sakc_sources(source_id,name,url,license,rights_status,proof) values('t-w','w','u','CC-BY-SA-4.0','rights_verified','{\"a\":1}') on conflict do nothing")
        c.execute("insert into sakc_corpus_versions values('t-v0','{}') on conflict do nothing")
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("insert into sakc_resources(resource_id,source_id,url,license,rights_status,country,language,sha256,version,split) values('t-r','t-w','u','x','unknown','BJ','fon',repeat('b',64),'t-v0','train')")
