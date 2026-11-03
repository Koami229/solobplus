"""Vague 3 : S01 catalogue par niveau, S02 tuteur IA expérimental sourcé, S06 validation des contenus en langue."""
import psycopg, pytest
from fastapi.testclient import TestClient
from solob_school.app import create_app
from solob_school import wave3
from tests.test_school import DB, SECRET, mkuser, h, GOOD
from tests.test_school_features import TEXT, upload

pytestmark = pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset")

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STORAGE_DIR", str(tmp_path))
    return TestClient(create_app(DB, SECRET))

def test_s01_catalog_only_subjects_of_profile_level(client):
    u = mkuser()
    assert client.get("/catalog/mine", headers=h(u)).json()["error"]["code"] == "PROFILE_REQUIRED"
    assert client.post("/profile", json=GOOD, headers=h(u)).status_code == 200
    r = client.get("/catalog/mine", headers=h(u)).json()
    ids = {s["id"] for s in r["subjects"]}
    assert ids == {"sub_bj_svt", "sub_bj_math", "sub_bj_pct"} and r["level"]["id"] == "lvl_bj_tle_cd"
    # changement de niveau → la liste suit
    assert client.post("/profile", json=GOOD | {"levelId": "lvl_bj_3e", "primarySubjectId": "sub_bj_hist"}, headers=h(u)).status_code == 200
    assert {s["id"] for s in client.get("/catalog/mine", headers=h(u)).json()["subjects"]} == {"sub_bj_hist"}

def test_s02_tutor_cites_source_or_says_no_source(client):
    u = mkuser()
    did = upload(client, u).json()["document"]["id"]
    r = client.post("/tutor", json={"question": "Où se fait la photosynthèse et la chlorophylle ?", "documentId": did}, headers=h(u)).json()
    assert r["experimental"] and "expérimental" in r["label"] and r["hasSource"]
    assert len(r["citations"]) >= 1 and all(c["excerpt"] in TEXT for c in r["citations"]) and r["citations"][0]["documentId"] == did
    r = client.post("/tutor", json={"question": "Quelle est la capitale du Japon ?", "documentId": did}, headers=h(u)).json()
    assert r["hasSource"] is False and r["answer"].startswith("Aucune source") and r["citations"] == []
    r = client.post("/tutor", json={"question": "Explique la photosynthèse"}, headers=h(u)).json()
    assert r["hasSource"] is False and r["answer"] == wave3.NO_SOURCE
    other = mkuser()
    assert client.post("/tutor", json={"question": "photosynthèse", "documentId": did}, headers=h(other)).status_code == 403

def test_s02_tutor_answer_pure_never_invents():
    assert wave3.tutor_answer(None, "question")["hasSource"] is False
    doc = {"id": "d", "title": "T", "extracted_text": TEXT, "verified_source": False}
    assert wave3.tutor_answer(doc, "et ça ?")["hasSource"] is False
    r = wave3.tutor_answer(doc, "chlorophylle lumière")
    assert r["hasSource"] and r["answer"].count("\n[") == len(r["citations"])

def test_s06_language_content_validated_by_distinct_specialist(client):
    author, spec, student = mkuser("teacher"), mkuser("teacher"), mkuser()
    assert client.post("/language-contents", json={"language": "fon", "title": "Salutations", "body": "Contenu de cours en fon"}, headers=h(student)).status_code == 403
    r = client.post("/language-contents", json={"language": "fon", "title": "Salutations", "body": "Contenu de cours en fon"}, headers=h(author, "teacher"))
    assert r.status_code == 201, r.text
    cid = r.json()["contentId"]
    seen = lambda: [x["content_id"] for x in client.get("/language-contents?language=fon", headers=h(student)).json()["contents"]]
    assert cid not in seen()
    assert client.post(f"/language-contents/{cid}/review", json={"decision": "validated"}, headers=h(author, "teacher")).json()["error"]["code"] == "SELF_REVIEW_FORBIDDEN"
    assert client.post(f"/language-contents/{cid}/review", json={"decision": "rejected"}, headers=h(spec, "teacher")).status_code == 400
    assert client.post(f"/language-contents/{cid}/review", json={"decision": "validated"}, headers=h(student)).status_code == 403
    assert cid not in seen()
    assert client.post(f"/language-contents/{cid}/review", json={"decision": "validated"}, headers=h(spec, "teacher")).json()["status"] == "validated"
    assert cid in seen()
    with psycopg.connect(DB) as c:
        assert c.execute("SELECT validator_id FROM school_language_contents WHERE content_id=%s", (cid,)).fetchone()[0] == spec
        assert c.execute("SELECT COUNT(*) FROM audit_events WHERE target_id=%s AND action='LANG_CONTENT_REVIEW'", (cid,)).fetchone()[0] == 2
