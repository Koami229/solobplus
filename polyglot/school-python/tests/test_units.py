"""Pure unit tests (no DB)."""
import base64, pytest
from solob_school import grounding, storage, grader
from solob_school.errors import AppError

def err(fn, *a):
    with pytest.raises(AppError) as e: fn(*a)
    return e.value.code, e.value.status

def test_mime_inference_matches_ts():
    assert storage.infer_mime("a.pdf", "text/plain") == "application/pdf"
    assert storage.infer_mime("a.json", "text/plain") == "application/json"
    assert storage.infer_mime("a.md", None) == "text/markdown"
    assert storage.infer_mime("a.xyz", "image/png") == "image/png"
    assert storage.infer_mime("noext", None) == "application/octet-stream"

def test_upload_validation_rules(monkeypatch):
    assert err(storage.validate_upload, "x.exe", None, b"abc") == ("FORBIDDEN_FILE_TYPE", 400)
    assert err(storage.validate_upload, "x.svg", "text/plain", b"abc") == ("FORBIDDEN_FILE_TYPE", 400)
    assert err(storage.validate_upload, "x.png", "image/png", b"abc") == ("INVALID_MIME_TYPE", 400)
    assert err(storage.validate_upload, "  ", None, b"abc") == ("INVALID_FILE_NAME", 400)
    assert err(storage.validate_upload, "x" * 201 + ".txt", None, b"abc") == ("INVALID_FILE_NAME", 400)
    assert err(storage.validate_upload, "x.txt", None, b"") == ("EMPTY_FILE", 400)
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "10")
    assert err(storage.validate_upload, "x.txt", None, b"a" * 11) == ("FILE_TOO_LARGE", 413)

def test_signatures():
    for bad in (b"\x7fELF....", b"MZ......", b"#!/bin/sh", bytes.fromhex("cffaedfe") + b"xx"):
        assert err(storage.validate_upload, "x.txt", None, bad)[0] == "INVALID_FILE_SIGNATURE"
    assert err(storage.validate_upload, "x.pdf", None, b"not a pdf")[0] == "INVALID_FILE_SIGNATURE"
    assert err(storage.validate_upload, "x.wav", None, b"RIFF0000XXXX")[0] == "INVALID_FILE_SIGNATURE"
    assert storage.validate_upload("x.wav", None, b"RIFF0000WAVEfmt ")[1] == "audio/wav"
    assert storage.validate_upload("x.mp3", None, b"\xff\xfb\x90")[1] == "audio/mpeg"
    assert err(storage.validate_upload, "x.txt", None, b"a\x00b")[0] == "INVALID_FILE_SIGNATURE"
    assert err(storage.validate_upload, "x.json", None, b"{bad")[0] == "INVALID_FILE_CONTENT"

def test_storage_path_traversal_blocked(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_STORAGE_DIR", str(tmp_path))
    assert err(storage.safe_path, "../../etc/passwd")[0] == "INVALID_STORAGE_KEY"

def test_pdf_extraction():
    assert grounding.extract_text(b"%PDF-1.4 (Hello world) (La photosynthese)", "application/pdf") == "Hello world La photosynthese"
    assert grounding.extract_text(b"%PDF-1.4 1 0 obj stream Texte libre endstream", "application/pdf") == "1 0 Texte libre"

def doc(text, verified=True): return {"id": "doc_1", "title": "T", "extracted_text": text, "verified_source": verified}

def test_citations_ranking_and_uncertainty():
    t = "La photosynthèse convertit la lumière en énergie chimique. Les mitochondries produisent l'ATP cellulaire. Phrase courte."
    cits, unc = grounding.extract_citations(doc(t), "Explique la photosynthèse et la lumière")
    assert cits[0]["excerpt"].startswith("La photosynthèse") and unc == "LOW"
    assert len(cits) == 2  # "Phrase courte." (<=20 chars) excluded
    assert grounding.extract_citations(doc(t, False), "photosynthèse lumière énergie chimique")[1] == "MEDIUM"
    assert grounding.extract_citations(None, "x") == ([], "HIGH")
    cits, unc = grounding.extract_citations(doc("court"), "question longue")
    assert cits[0]["relevanceScore"] == 0.35 and unc == "MEDIUM"
    assert all(c["relevanceScore"] >= 0.25 for c in grounding.extract_citations(doc(t), "zzzz yyyy")[0])

def test_top_keywords():
    assert grounding.top_keywords("La photosynthèse photosynthèse convertit lumière énergie chimique") == ["photosynthèse", "convertit", "lumière", "énergie"]
    assert grounding.top_keywords("a b c") == ["concept", "analyse"]

def test_grader_protocol_is_byte_safe():
    data = grader.encode([{"maxPoints": 10, "expectedKeywords": ["Énergie"]}], ["x|y\n 3 2\nÉNERGIE"], 20)
    assert data.startswith(b"SOLOBGRADE1 20.0 1\n10.0 1\n8\n\xc3\xa9nergie\n")

@pytest.mark.skipif(not grader.DEFAULT_BIN.exists(), reason="C++ grader not built")
def test_cpp_grader_parity_with_ts_formula():
    qs = [{"id": "q1", "maxPoints": 10, "expectedKeywords": ["lumière", "énergie"]}, {"id": "q2", "maxPoints": 10, "expectedKeywords": []}]
    g = grader.grade(qs, ["La LUMIÈRE produit de l'énergie chimique pour la plante verte.", ""], 20)
    # q1: len>=40 -> 5 + 5*1 = 10 ; q2: empty answer, no keywords -> 0.5*10*0.5 = 2.5
    assert [q["points"] for q in g["questions"]] == [10, 2.5] and g["score"] == 12.5 and g["percent"] == 62.5
    assert g["questions"][0]["matchedIndices"] == [0, 1]

def test_grader_missing_binary_fails_closed(monkeypatch):
    monkeypatch.setenv("GRADER_BIN", "/nonexistent/solob-grade")
    assert err(grader.grade, [], [], 20) == ("GRADER_UNAVAILABLE", 503)

def test_pool_is_reused_and_reports_missing_db():
    import os, pytest
    from solob_school import db
    from solob_school.errors import AppError
    with pytest.raises(AppError) as e:
        db.connection("")
    assert e.value.status == 503
    url = os.environ.get("TEST_DATABASE_URL")
    if not url: pytest.skip("TEST_DATABASE_URL unset")
    pids = []
    for _ in range(25):
        with db.connection(url) as c1: pids.append(c1.execute("SELECT pg_backend_pid() AS p").fetchone()["p"])
    assert len(set(pids)) <= 10, "sequential checkouts must reuse pooled backends (max_size=10)"
    import secrets
    tag = secrets.token_hex(8)
    with pytest.raises(RuntimeError):
        with db.connection(url) as c:
            c.execute("INSERT INTO rate_limit_buckets (bucket_key, hit_count, window_start, window_ms, updated_at) VALUES (%s, 1, NOW(), 60000, NOW())", (f"pool-probe-{tag}",))
            raise RuntimeError("boom")
    with db.connection(url) as c:
        assert c.execute("SELECT count(*) AS n FROM rate_limit_buckets WHERE bucket_key=%s", (f"pool-probe-{tag}",)).fetchone()["n"] == 0


def test_service_secret_startup_rules():
    import pytest
    from solob_school.config import resolve_service_secret, DEV_ONLY_SERVICE_SECRET
    good = "s" * 32
    assert resolve_service_secret(good, "production") == good
    assert resolve_service_secret(None, "development") == DEV_ONLY_SERVICE_SECRET
    assert len(DEV_ONLY_SERVICE_SECRET) >= 32
    for raw, env in [(None, "production"), ("", None), ("short", "development"), ("x" * 31, "production"),
                     ("changeme" * 5, "production"), (None, "staging")]:
        with pytest.raises(RuntimeError):
            resolve_service_secret(raw, env)
