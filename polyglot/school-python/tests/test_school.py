"""Requires TEST_DATABASE_URL pointing at a migrated PG database (e.g. created by the Rust gateway `migrate`)."""
import os, secrets, threading
import psycopg, pytest
from fastapi.testclient import TestClient
from solob_school.app import create_app

DB = os.environ.get("TEST_DATABASE_URL")
SECRET = "s" * 40
pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset")

def mkuser(role="student"):
    uid = "usr_" + secrets.token_hex(6)
    with psycopg.connect(DB) as c:
        c.execute("INSERT INTO users (id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','T',%s,%s)",
                  (uid, uid + "@e.org", role, "school" if role in ("student", "teacher") else "business"))
    return uid

def h(uid, role="student", secret=SECRET):
    return {"x-solob-service-secret": secret, "x-solob-user-id": uid, "x-solob-user-role": role, "x-solob-user-email": "a@e.org"}

@pytest.fixture
def client():
    return TestClient(create_app(DB, SECRET))

GOOD = {"country": "BJ", "curriculumId": "cur_bj_bac", "levelId": "lvl_bj_tle_cd", "primarySubjectId": "sub_bj_svt"}

def test_health_needs_no_secret(client):
    assert client.get("/health").json() == {"ok": True, "service": "school-python"}

def test_rejects_missing_or_wrong_service_secret(client):
    assert client.get("/catalog").status_code == 401
    assert client.get("/catalog", headers=h("u", secret="wrong" * 10)).json()["error"]["code"] == "SERVICE_UNAUTHENTICATED"

def test_empty_configured_secret_fails_closed():
    c = TestClient(create_app(DB, ""))
    assert c.get("/catalog", headers=h("u", secret="")).status_code == 401

def test_business_role_forbidden(client):
    r = client.post("/profile", json=GOOD, headers=h("u", "org_client"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN_ROLE"

def test_catalog_seeded(client):
    r = client.get("/catalog", headers=h("u")).json()
    assert {c["id"] for c in r["curricula"]} >= {"cur_bj_bac", "cur_waec_sss", "cur_sn_bac"}

def test_profile_upsert_create_then_update_with_audit(client):
    uid = mkuser()
    r = client.post("/profile", json=GOOD | {"institutionName": "  Lycée Béhanzin "}, headers=h(uid))
    assert r.status_code == 200, r.text
    p = r.json()["profile"]
    assert p["institution_name"] == "Lycée Béhanzin" and p["curriculum_verified"] is True and p["profile_type"] == "student"
    r2 = client.post("/profile", json=GOOD | {"primarySubjectId": "sub_bj_math"}, headers=h(uid)).json()["profile"]
    assert r2["id"] == p["id"] and r2["primary_subject_id"] == "sub_bj_math"
    with psycopg.connect(DB) as c:
        assert c.execute("SELECT COUNT(*) FROM academic_profiles WHERE user_id=%s", (uid,)).fetchone()[0] == 1
        assert c.execute("SELECT COUNT(*) FROM audit_events WHERE actor_user_id=%s AND action='ACADEMIC_PROFILE_SAVED'", (uid,)).fetchone()[0] == 2

def test_validation_errors(client):
    uid = mkuser()
    assert client.post("/profile", json={"country": "BJ"}, headers=h(uid)).json()["error"]["code"] == "MISSING_PROFILE_FIELDS"
    assert client.post("/profile", json=GOOD | {"curriculumId": "nope"}, headers=h(uid)).status_code == 404
    r = client.post("/profile", json=GOOD | {"primarySubjectId": "sub_waec_bio"}, headers=h(uid))
    assert r.json()["error"]["code"] == "INVALID_PROFILE_SELECTION"

def test_teacher_profile_type_and_concurrent_upserts_single_row(client):
    uid = mkuser("teacher")
    codes = []
    def go():
        codes.append(client.post("/profile", json=GOOD, headers=h(uid, "teacher")).status_code)
    ts = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert codes == [200] * 6
    with psycopg.connect(DB) as c:
        assert c.execute("SELECT profile_type, COUNT(*) OVER () FROM academic_profiles WHERE user_id=%s", (uid,)).fetchall() == [("teacher", 1)]
