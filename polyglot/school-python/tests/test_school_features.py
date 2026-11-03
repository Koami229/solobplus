"""PG16 integration tests for documents, files, explanations, revisions, submissions (C++ grader), workspace."""
import base64, os, secrets
import psycopg, pytest
from fastapi.testclient import TestClient
from solob_school.app import create_app
from solob_school import grader
from tests.test_school import DB, SECRET, mkuser, h

pytestmark = [pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset"),
              pytest.mark.skipif(not grader.DEFAULT_BIN.exists() and not os.environ.get("GRADER_BIN"), reason="C++ grader not built")]

TEXT = ("La photosynthèse convertit l'énergie lumineuse en énergie chimique dans les chloroplastes. "
        "La chlorophylle absorbe principalement la lumière rouge et bleue. "
        "Le glucose produit est utilisé pour la respiration cellulaire.")

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STORAGE_DIR", str(tmp_path))
    monkeypatch.setenv("AI_RATE_LIMIT_PER_MINUTE", "1000")
    return TestClient(create_app(DB, SECRET))

def q(sql, *a):
    with psycopg.connect(DB) as c: return c.execute(sql, a).fetchall()

def upload(client, uid, role="student", **kw):
    body = {"title": "Cours SVT", "originalFileName": "cours.txt", "content": TEXT, **kw}
    return client.post("/documents", json=body, headers=h(uid, role))

def test_upload_text_document_stores_private_file_and_audits(client, tmp_path):
    u = mkuser()
    r = upload(client, u); assert r.status_code == 201, r.text
    d, f = r.json()["document"], r.json()["storedFile"]
    assert d["word_count"] == len(TEXT.split()) and d["is_teacher_resource"] is False and f["visibility"] == "private"
    files = list(tmp_path.rglob("*_cours.txt")); assert len(files) == 1 and oct(files[0].stat().st_mode)[-3:] == "600"
    assert q("SELECT action FROM audit_events WHERE target_id=%s", f["id"]) == [("FILE_UPLOADED",)]
    assert q("SELECT progress_delta::int FROM school_learning_activities WHERE reference_id=%s", d["id"]) == [(10,)]

def test_student_cannot_publish_teacher_resource_but_teacher_can(client):
    s, t = mkuser(), mkuser("teacher")
    assert upload(client, s, isTeacherResource=True).json()["document"]["is_teacher_resource"] is False
    r = upload(client, t, "teacher", isTeacherResource=True).json()
    assert r["document"]["verified_source"] is True and r["storedFile"]["visibility"] == "curriculum_resource"

def test_blocked_extension_is_audited_and_nothing_stored(client, tmp_path):
    u = mkuser()
    r = upload(client, u, originalFileName="evil.sh")
    assert r.status_code == 400 and r.json()["error"]["code"] == "FORBIDDEN_FILE_TYPE"
    assert q("SELECT status FROM audit_events WHERE actor_user_id=%s AND action='FILE_UPLOAD_BLOCKED_EXTENSION'", u) == [("DENIED",)]
    assert q("SELECT count(*) FROM stored_files WHERE owner_user_id=%s", u) == [(0,)] and not list(tmp_path.rglob("*"))

def test_content_too_short_rolls_back_file_and_object(client, tmp_path):
    u = mkuser()
    r = upload(client, u, content="court")
    assert r.json()["error"]["code"] == "CONTENT_TOO_SHORT"
    assert q("SELECT count(*) FROM stored_files WHERE owner_user_id=%s", u) == [(0,)] and not list(tmp_path.rglob("*.txt"))

def test_pdf_base64_upload_and_bad_signature(client):
    u = mkuser()
    pdf = b"%PDF-1.4\n(La mitose produit deux cellules filles identiques.) (Prophase, metaphase, anaphase.)"
    r = client.post("/documents", json={"title": "Mitose", "originalFileName": "m.pdf", "contentBase64": base64.b64encode(pdf).decode()}, headers=h(u))
    assert r.status_code == 201 and "mitose" in r.json()["document"]["extracted_text"].lower()
    r = client.post("/documents", json={"title": "Faux", "originalFileName": "f.pdf", "contentBase64": base64.b64encode(b"MZ\x90\x00").decode()}, headers=h(u))
    assert r.json()["error"]["code"] == "INVALID_FILE_SIGNATURE"

def test_oversize_upload_413(client, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "64")
    r = upload(client, mkuser(), content="x" * 65)
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"

def test_file_read_ownership(client):
    a, b, adm, t = mkuser(), mkuser(), mkuser("admin"), mkuser("teacher")
    fid = upload(client, a).json()["storedFile"]["id"]
    assert client.get(f"/files/{fid}", headers=h(a)).json()["textContent"] == TEXT
    assert client.get(f"/files/{fid}", headers=h(adm, "admin")).status_code == 200
    r = client.get(f"/files/{fid}", headers=h(b)); assert r.status_code == 403
    assert q("SELECT count(*) FROM audit_events WHERE actor_user_id=%s AND action='FILE_ACCESS_DENIED'", b) == [(1,)]
    assert client.get("/files/fil_nope", headers=h(a)).status_code == 404
    tf = upload(client, t, "teacher", isTeacherResource=True).json()["storedFile"]["id"]
    assert client.get(f"/files/{tf}", headers=h(b)).status_code == 200
    assert "storage_key" not in client.get(f"/files/{fid}", headers=h(a)).json()["metadata"]

def test_grounded_explanation_and_private_doc_denied(client):
    a, b = mkuser(), mkuser()
    did = upload(client, a).json()["document"]["id"]
    r = client.post("/explanations", json={"question": "Comment fonctionne la photosynthèse dans les chloroplastes ?", "documentId": did}, headers=h(a))
    j = r.json(); assert r.status_code == 200, r.text
    assert j["aiResult"]["aiMode"] == "MOCK_DEMO" and j["aiResult"]["groundingCitations"][0]["documentId"] == did
    assert j["material"]["material_type"] == "EXPLANATION" and j["material"]["content_json"]["explanation"].startswith("Grounded Academic Explanation")
    assert q("SELECT provider,status,is_mock FROM ai_usage_records WHERE user_id=%s", a) == [("mock", "SUCCESS", True)]
    r = client.post("/explanations", json={"question": "Expliquer ce document", "documentId": did}, headers=h(b))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN_DOCUMENT_ACCESS"
    r = client.post("/explanations", json={"question": "Qu'est-ce qu'une cellule ?"}, headers=h(b))
    assert r.json()["material"]["content_json"]["explanation"].startswith("Unanchored") and r.json()["aiResult"]["uncertaintyLevel"] == "HIGH"
    assert client.post("/explanations", json={"question": "ab"}, headers=h(b)).json()["error"]["code"] == "INVALID_AI_PROMPT"

def test_explanation_is_deterministic(client):
    a = mkuser(); did = upload(client, a).json()["document"]["id"]
    body = {"question": "Rôle de la chlorophylle et de la lumière", "documentId": did}
    x = [client.post("/explanations", json=body, headers=h(a)).json()["aiResult"]["data"] for _ in range(2)]
    assert x[0] == x[1]

def test_provider_failure_fallback_and_strict(client):
    a = mkuser()
    r = client.post("/explanations", json={"question": "Question test", "simulateProviderFailure": True}, headers=h(a))
    assert r.status_code == 200 and "FALLBACK" in r.json()["aiResult"]["epistemicNotice"]
    r = client.post("/explanations", json={"question": "Question test", "simulateProviderFailure": True, "strictLiveRequired": True}, headers=h(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "AI_PROVIDER_UNAVAILABLE"
    assert sorted(q("SELECT status FROM ai_usage_records WHERE user_id=%s", a)) == [("ERROR",), ("FALLBACK_MOCK",)]
    assert q("SELECT count(*) FROM audit_events WHERE actor_user_id=%s AND action='AI_PROVIDER_FAILURE_HANDLED'", a) == [(2,)]

def test_ai_rate_limit(client, monkeypatch):
    monkeypatch.setenv("AI_RATE_LIMIT_PER_MINUTE", "2"); a = mkuser()
    codes = [client.post("/explanations", json={"question": "Question test"}, headers=h(a)).status_code for _ in range(3)]
    assert codes == [200, 200, 429]

def test_generate_then_submit_graded_by_cpp(client):
    a, other = mkuser(), mkuser()
    did = upload(client, a).json()["document"]["id"]
    r = client.post("/revisions", json={"title": "Photosynthèse", "documentId": did, "materialType": "FLASHCARDS", "difficulty": "EXAM_LEVEL"}, headers=h(a))
    assert r.status_code == 201, r.text
    ex = r.json()["exercise"]; assert ex["max_score"] == 20 or float(ex["max_score"]) == 20.0
    qs = ex["questions_json"]; assert [x["id"] for x in qs] == ["q1", "q2"] and len(r.json()["studyMaterial"]["content_json"]["flashcards"]) == 2
    good = " ".join(qs[0]["expectedKeywords"]) + " — explication détaillée du mécanisme étudié en cours."
    r = client.post("/submissions", json={"exerciseId": ex["id"], "answers": {"q1": good, "q2": ""}}, headers=h(a))
    assert r.status_code == 201, r.text
    s = r.json()["submission"]
    k2 = len(qs[1]["expectedKeywords"])
    assert float(s["score"]) == 10.0 and float(s["percentage"]) == 50.0 and k2 > 0
    assert s["corrections_json"][0]["matchedKeywords"] == qs[0]["expectedKeywords"]
    assert s["overall_feedback"].startswith("Résultat encourageant (10/20 — 50%)")
    # hardening: a student cannot submit to another student's private exercise
    r = client.post("/submissions", json={"exerciseId": ex["id"], "answers": {}}, headers=h(other))
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN_EXERCISE_ACCESS"
    assert client.post("/submissions", json={"exerciseId": "exr_nope", "answers": {}}, headers=h(a)).status_code == 404
    w = client.get("/workspace", headers=h(a)).json()
    assert w["progressSummary"] == {"totalActivities": 3, "documentsUploaded": 1, "exercisesCompleted": 1,
                                    "averageScorePercentage": 50.0, "cumulativeProgressScore": 37}

def test_generate_validation(client):
    a = mkuser()
    assert client.post("/revisions", json={"title": "x"}, headers=h(a)).json()["error"]["code"] == "INVALID_TITLE"
    assert client.post("/revisions", json={"title": "Titre", "materialType": "POEM"}, headers=h(a)).json()["error"]["code"] == "INVALID_MATERIAL_TYPE"
    assert client.post("/revisions", json={"title": "Titre", "difficulty": "HARD"}, headers=h(a)).json()["error"]["code"] == "INVALID_DIFFICULTY"

def test_business_roles_cannot_use_school_features(client):
    o = mkuser("operator")
    for path in ("/documents", "/explanations", "/revisions", "/submissions"):
        assert client.post(path, json={}, headers=h(o, "operator")).status_code == 403
    assert client.get("/workspace", headers=h(o, "operator")).status_code == 403
