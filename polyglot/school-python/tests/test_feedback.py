"""« Réponse utile » feedback (db/migrations-ai/006, opt-in). Applies 005+006 (additive, idempotent) to the test DB."""
import json, os, pathlib, secrets
import psycopg, pytest
from fastapi.testclient import TestClient
from solob_school.app import create_app

DB = os.environ.get("TEST_DATABASE_URL")
SECRET = "s" * 40

def mkuser(role="student"):
    uid = "usr_" + secrets.token_hex(6)
    with psycopg.connect(DB) as c:
        c.execute("INSERT INTO users (id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','T',%s,'school')", (uid, uid + "@e.org", role))
    return uid

def h(uid, role="student"):
    return {"x-solob-service-secret": SECRET, "x-solob-user-id": uid, "x-solob-user-role": role, "x-solob-user-email": "a@e.org"}

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset")
MIG = pathlib.Path(__file__).resolve().parents[3] / "db" / "migrations-ai"

@pytest.fixture(scope="module")
def client():
    with psycopg.connect(DB, autocommit=True) as c:
        for f in ("005_human_review.sql", "006_contributions.sql"):
            c.execute((MIG / f).read_text())
    return TestClient(create_app(DB, SECRET))

def material(uid):
    mid = "mat_" + secrets.token_hex(6)
    with psycopg.connect(DB) as c:
        c.execute("""INSERT INTO school_study_materials (id,user_id,material_type,title,prompt_text,content_json,ai_mode)
                     VALUES (%s,%s,'EXPLANATION','t','q',%s::jsonb,'MOCK_DEMO')""", (mid, uid, json.dumps({"explanation": "x"})))
    return mid

def test_feedback_upsert_owner_only_and_audited(client):
    u, other = mkuser(), mkuser()
    mid = material(u)
    r = client.post("/feedback", json={"materialId": mid, "helpful": True}, headers=h(u))
    assert r.status_code == 200 and r.json()["feedback"]["helpful"] is True
    r = client.post("/feedback", json={"materialId": mid, "helpful": False, "comment": "trop vague"}, headers=h(u))
    assert r.json()["feedback"]["helpful"] is False
    with psycopg.connect(DB) as c:
        rows = c.execute("SELECT helpful, comment FROM ai_answer_feedback WHERE material_id=%s", (mid,)).fetchall()
        assert rows == [(False, "trop vague")]
        n = c.execute("SELECT count(*) FROM audit_events WHERE target_id=%s AND action='AI_ANSWER_FEEDBACK'", (mid,)).fetchone()[0]
        assert n == 2
    r = client.post("/feedback", json={"materialId": mid, "helpful": True}, headers=h(other))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN_MATERIAL_ACCESS"

def test_feedback_validation(client):
    u = mkuser()
    assert client.post("/feedback", json={"materialId": "nope", "helpful": True}, headers=h(u)).status_code == 404
    assert client.post("/feedback", json={"materialId": material(u)}, headers=h(u)).status_code == 400
    assert client.post("/feedback", json={"materialId": "x", "helpful": True}, headers=h(u, "org_client")).status_code == 403
