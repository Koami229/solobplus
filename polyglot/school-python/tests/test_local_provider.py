"""Fournisseur expérimental solob-local: désactivé par défaut, boucle locale uniquement, limites et journaux conservés."""
import json, os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from solob_school import local_provider as lp

def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("SOLOB_LOCAL_ENABLED", raising=False); monkeypatch.setenv("SOLOB_LOCAL_URL", "http://127.0.0.1:1/generate")
    assert lp.enabled() is False
    monkeypatch.setenv("SOLOB_LOCAL_ENABLED", "1"); monkeypatch.delenv("SOLOB_LOCAL_URL")
    assert lp.enabled() is False

@pytest.mark.parametrize("url", ["https://api.example.com/generate", "http://10.0.0.5:8000/g", "http://evil.com/g", "file:///etc/passwd"])
def test_non_loopback_rejected(monkeypatch, url):
    monkeypatch.setenv("SOLOB_LOCAL_URL", url)
    with pytest.raises(lp.LocalProviderError): lp.generate("bonjour")

class _H(BaseHTTPRequestHandler):
    calls = []
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _H.calls.append(body)
        out = json.dumps({"text": "brouillon local", "completion_tokens": 3, "model": "solob-ai-v1-cpu"}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

@pytest.fixture
def fake_server():
    s = HTTPServer(("127.0.0.1", 0), _H); t = threading.Thread(target=s.serve_forever, daemon=True); t.start()
    _H.calls.clear(); yield f"http://127.0.0.1:{s.server_port}/generate"; s.shutdown()

def test_generate_contract_and_token_cap(monkeypatch, fake_server):
    monkeypatch.setenv("SOLOB_LOCAL_URL", fake_server); monkeypatch.setenv("SOLOB_LOCAL_MAX_NEW_TOKENS", "9999")
    out = lp.generate("Explique la mitose")
    assert out == {"text": "brouillon local", "completion_tokens": 3, "model": "solob-ai-v1-cpu"}
    assert _H.calls == [{"prompt": "Explique la mitose", "max_new_tokens": 512}]

# ---- intégration PG16 (même conditions que test_school_features) ----
from tests.test_school_features import client, q, upload, mkuser, h, DB, pytestmark as _pm  # noqa: E402,F401

@pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset")
def test_school_uses_local_when_enabled(client, monkeypatch, fake_server):
    monkeypatch.setenv("SOLOB_LOCAL_ENABLED", "1"); monkeypatch.setenv("SOLOB_LOCAL_URL", fake_server)
    a = mkuser(); did = upload(client, a).json()["document"]["id"]
    r = client.post("/explanations", json={"question": "Rôle de la chlorophylle", "documentId": did}, headers=h(a)); assert r.status_code == 200, r.text
    ai = r.json()["aiResult"]
    assert ai["aiMode"] == "LIVE" and ai["provider"] == "solob-local" and ai["experimental"] is True and "EXPERIMENTAL" in ai["epistemicNotice"]
    assert ai["data"]["localModelDraft"] == "brouillon local" and ai["groundingCitations"][0]["documentId"] == did
    assert q("SELECT provider,model,status,is_mock,completion_tokens FROM ai_usage_records WHERE user_id=%s", a) == [("solob-local", "solob-ai-v1-cpu", "SUCCESS", False, 3)]

@pytest.mark.skipif(not DB, reason="TEST_DATABASE_URL unset")
def test_school_local_failure_fallback_strict_and_rate_limit(client, monkeypatch):
    monkeypatch.setenv("SOLOB_LOCAL_ENABLED", "1"); monkeypatch.setenv("SOLOB_LOCAL_URL", "http://127.0.0.1:9/generate")  # port fermé
    monkeypatch.setenv("SOLOB_LOCAL_TIMEOUT_S", "1"); monkeypatch.setenv("AI_MAX_RETRIES", "1"); a = mkuser()
    r = client.post("/explanations", json={"question": "Question test"}, headers=h(a))
    assert r.status_code == 200 and r.json()["aiResult"]["aiMode"] == "MOCK_DEMO" and r.json()["aiResult"]["usage"]["status"] == "FALLBACK_MOCK"
    r = client.post("/explanations", json={"question": "Question test", "strictLiveRequired": True}, headers=h(a))
    assert r.status_code == 503 and r.json()["error"]["code"] == "AI_PROVIDER_UNAVAILABLE"
    rows = q("SELECT provider,status FROM ai_usage_records WHERE user_id=%s ORDER BY created_at", a)
    assert ("solob-local", "FALLBACK_MOCK") in rows and ("solob-local", "ERROR") in rows
    assert q("SELECT count(*) FROM audit_events WHERE actor_user_id=%s AND action='AI_PROVIDER_FAILURE_HANDLED'", a) == [(2,)]
    monkeypatch.setenv("AI_RATE_LIMIT_PER_MINUTE", "1"); b = mkuser()
    codes = [client.post("/explanations", json={"question": "Question test"}, headers=h(b)).status_code for _ in range(2)]
    assert codes == [200, 429]
