"""Phase D : ingestion v1.N, mélange par température, pilote de réentraînement, porte de promotion, registre, migration 007."""
import datetime as dt, hashlib, json, os, pathlib, re, uuid
import numpy as np, pytest, torch
from solob_ai.pipeline import ingest, mix, registry, promote, guard
from solob_ai.pipeline.retrain import RetrainConfig, MixedBatches, retrain

LANGS = ["fon", "yo", "ha", "wo", "ig", "sw", "fr", "en"]
WORDS = {l: [f"{l}{i}a" for i in range(40)] for l in LANGS}
DB = pathlib.Path(__file__).resolve().parents[3] / "db"

def doc(lang, seed, n=80):
    r = np.random.default_rng(seed); return " ".join(r.choice(WORDS[lang], n))

def sha(t): return hashlib.sha256(t.encode()).hexdigest()

def contrib(i, lang="fon", text=None, **kw):
    t = text or doc(lang, 1000 + i)
    r = {"id": f"contrib:c{i}", "kind": "text", "language": lang, "source_text": None, "text": t, "sha256": sha(t),
         "license": "CC-BY-4.0", "attribution": "K", "rights": {"consent_version": "contrib-v1", "consent_at": "2026-11-02T00:00:00",
         "double_validated": True, "distinct_accepts": 2, "review_item_id": f"contrib_c{i}"}, "provenance": {"origin": "test"}}
    r.update(kw); return r

@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    v1 = tmp_path / "data/sakc/v1"; v1.mkdir(parents=True)
    for split, base in (("train", 0), ("val", 500), ("test", 700)):
        with open(v1 / f"{split}.jsonl", "w") as f:
            for l in LANGS:
                for k in range(3 if split == "train" else 2):
                    t = doc(l, base + LANGS.index(l) * 10 + k); f.write(json.dumps({"language": l, "text": t, "sha256": sha(t)}) + "\n")
    (v1 / "MANIFEST.json").write_text('{"version":"v1"}')
    import sentencepiece as spm
    tok = tmp_path / "tok"; tok.mkdir()
    spm.SentencePieceTrainer.train(sentence_iterator=iter([doc(l, s) for l in LANGS for s in range(5)]), model_prefix=str(tok / "t"),
        vocab_size=200, model_type="unigram", user_defined_symbols=[f"<lang_{l}>" for l in LANGS], pad_id=0, unk_id=1, bos_id=2, eos_id=3,
        hard_vocab_limit=False, minloglevel=2)
    sp = spm.SentencePieceProcessor(model_file=str(tok / "t.model")); pt = tmp_path / "tokens"; pt.mkdir()
    for split in ("train", "val"):
        for l in LANGS:
            reps = 40 if l in ("fr", "en") and split == "train" else 6
            ids = []
            for s in range(reps): ids += [sp.piece_to_id(f"<lang_{l}>")] + sp.encode(doc(l, s)) + [3]
            np.save(pt / f"{split}_{l}.npy", np.array(ids, np.uint16))
    return tmp_path, str(tok / "t.model"), sp.get_piece_size()

# ------------------------------------------------------------------ ingestion
def test_ingest_rights_quality_dedup_provenance(world):
    root, *_ = world; exp = root / "export.jsonl"
    v1_train0 = json.loads((root / "data/sakc/v1/train.jsonl").read_text().splitlines()[0])
    test0 = json.loads((root / "data/sakc/v1/test.jsonl").read_text().splitlines()[0])
    recs = [contrib(1), contrib(2, "yo"), contrib(3, license="CC-BY-SA-4.0"), contrib(4, text=v1_train0["text"], language=v1_train0["language"]),
            contrib(5, text=test0["text"] + " x", language=test0["language"]), contrib(6, text="aaaa aaaa"), {**contrib(7), "sha256": "0" * 64},
            {**contrib(8), "rights": {**contrib(8)["rights"], "distinct_accepts": 1}}]
    exp.write_text("".join(json.dumps(r) + "\n" for r in recs))
    before = {p: p.read_bytes() for p in (root / "data/sakc/v1").iterdir()}
    m = ingest.ingest(exp, root / "data/sakc")
    assert m["version"] == "v1.1" and m["stats"]["input"] == 8
    assert m["stats"]["rights_rejected"] == {"license": 1, "hash_mismatch": 1, "single_validation": 1}
    out = [json.loads(l) for l in (root / "data/sakc/v1.1/contributions.jsonl").read_text().splitlines()]
    by = {r["id"]: r for r in out}
    assert set(by) == {"contrib:c1", "contrib:c2", "contrib:c4", "contrib:c5", "contrib:c6"}  # refus de droits jamais écrits
    assert by["contrib:c4"]["exclude_from_training"] and any(f.startswith("dup:exact:v1:train") for f in by["contrib:c4"]["quality_flags"])
    assert by["contrib:c5"]["exclude_from_training"] and any("v1:test" in f for f in by["contrib:c5"]["quality_flags"])  # pas de fuite du test
    assert by["contrib:c6"]["quality_flags"] and not by["contrib:c6"]["exclude_from_training"]  # drapeau seulement
    assert by["contrib:c1"]["provenance"] == {"origin": "test"} and by["contrib:c1"]["split"] == "train" and by["contrib:c1"]["rights"]["double_validated"]
    rej = (root / "data/sakc/v1.1/rejected.jsonl").read_text()
    assert "contrib:c3" in rej and recs[2]["text"] not in rej
    assert {p: p.read_bytes() for p in (root / "data/sakc/v1").iterdir()} == before   # v1 intact
    with pytest.raises(FileExistsError): ingest.ingest(exp, root / "data/sakc", version="v1.1")
    m2 = ingest.ingest(exp, root / "data/sakc")
    assert m2["version"] == "v1.2" and m2["stats"]["excluded_from_training"] == 5   # tout est déjà dans v1.1

def test_ingest_refuses_protected_path(world):
    root, *_ = world
    with pytest.raises(PermissionError): guard.assert_not_protected(root / "data/sakc/v0/x", root)
    with pytest.raises(PermissionError): guard.assert_not_protected(root / "artifacts/run_cpu_v1/last.pt", root)
    guard.assert_not_protected(root / "artifacts/candidates/x", root)

# ------------------------------------------------------------------ mélange
def test_temperature_mix_upweights_small_languages():
    sizes = {"en": 7_409_797, "fr": 7_135_044, "fon": 229_450, "ha": 929_701, "ig": 913_728, "sw": 1_897_814, "wo": 569_060, "yo": 890_633}
    nat = mix.temperature_weights(sizes, 1.0); t3 = mix.temperature_weights(sizes, 3.0, floor=0.05, cap=0.25)
    assert abs(sum(t3.values()) - 1) < 1e-5 and all(0.05 - 1e-6 <= v <= 0.25 + 1e-6 for v in t3.values())
    for l in ("fon", "yo", "ha", "wo", "ig"): assert t3[l] > nat[l]
    assert t3["en"] + t3["fr"] < nat["en"] + nat["fr"]
    assert mix.temperature_weights({"a": 10, "b": 1000}, 1e9) == pytest.approx({"a": 0.5, "b": 0.5}, abs=1e-3)
    with pytest.raises(ValueError): mix.temperature_weights({"a": 1, "b": 1}, 1.0, floor=0.6)

def test_mixed_batches_reproducible_and_follow_weights():
    s = {"a": np.arange(5000, dtype=np.uint16), "b": np.arange(5000, 10000).astype(np.uint16)}
    b1, b2 = MixedBatches(s, {"a": 0.8, "b": 0.2}, 8, 64, 7), MixedBatches(s, {"a": 0.8, "b": 0.2}, 8, 64, 7)
    for _ in range(5): assert torch.equal(b1.next()[0], b2.next()[0])
    assert 0.7 < b1.counts["a"] / 320 < 0.9

# ------------------------------------------------------------------ registre
def test_registry_append_only_chain(tmp_path):
    p = tmp_path / "r.jsonl"
    registry.append(p, {"id": "a", "event": "trained"}); registry.append(p, {"id": "a", "event": "evaluated"})
    with pytest.raises(FileExistsError): registry.append(p, {"id": "a", "event": "trained"})
    assert registry.verify_chain(p) == []
    lines = p.read_text().splitlines(); p.write_text(lines[0].replace('"a"', '"z"') + "\n" + lines[1] + "\n")
    assert registry.verify_chain(p) and pytest.raises(RuntimeError, registry.append, p, {"id": "b", "event": "trained"})

# ------------------------------------------------------------------ porte de promotion (pure)
INC = {"fon": 3.0, "yo": 2.9, "ha": 2.5, "wo": 2.8, "ig": 2.35, "sw": 2.3, "fr": 2.42, "en": 2.33}
def test_gate_refuses_regression_on_priority_language():
    cand = {**{l: v - 0.1 for l, v in INC.items()}, "fon": INC["fon"] + 0.03}
    d = promote.decide(INC, cand, promote.PRIORITY, 0.02)
    assert not d["promote"] and "fon" in d["reasons"][0]
def test_gate_accepts_small_noise_with_avg_gain():
    cand = {**{l: v - 0.05 for l, v in INC.items()}, "en": INC["en"] + 0.015}
    assert promote.decide(INC, cand, promote.PRIORITY, 0.02)["promote"]
def test_gate_refuses_without_avg_gain_and_missing_language():
    assert not promote.decide(INC, dict(INC), promote.PRIORITY)["promote"]
    d = promote.decide(INC, {l: v - 0.1 for l, v in INC.items() if l != "wo"}, promote.PRIORITY)
    assert not d["promote"] and "absentes" in d["reasons"][0]

# ------------------------------------------------------------------ bout en bout (mini modèle CPU)
def _cfg(root, tok, vocab, run_id, deltas=(), seed=1):
    return RetrainConfig(run_id=run_id, parent_tokens=str(root / "tokens"), tokenizer=tok, sakc=str(root / "data/sakc"), deltas=list(deltas),
        model={"vocab_size": vocab, "d_model": 32, "n_layers": 1, "n_heads": 2, "d_ff": 64, "max_seq_len": 32},
        mix={"temperature": 3.0}, registry=str(root / "reg/models.jsonl"), audit=str(root / "reg/audit.jsonl"),
        train={"threads": 1, "seed": seed, "batch_size": 4, "seq_len": 32, "lr": 0.003, "warmup_steps": 2, "max_steps": 6,
               "eval_every": 3, "eval_batches": 2, "out_dir": str(root / "cand" / run_id)})

def test_retrain_reproducible_audited_and_never_overwrites(world, monkeypatch):
    root, tok, vocab = world; monkeypatch.delenv("SOLOB_CONTRIB_DSN", raising=False)
    exp = root / "e.jsonl"; exp.write_text(json.dumps(contrib(1)) + "\n" + json.dumps(contrib(2, "wo")) + "\n"); ingest.ingest(exp, root / "data/sakc")
    a = retrain(_cfg(root, tok, vocab, "r1", ["v1.1"]), root=root, log=lambda *_: None)
    b = retrain(_cfg(root, tok, vocab, "r2", ["v1.1"]), root=root, log=lambda *_: None)
    la = [json.loads(l)["train_loss"] for l in (root / "cand/r1/losses.jsonl").read_text().splitlines()]
    lb = [json.loads(l)["train_loss"] for l in (root / "cand/r2/losses.jsonl").read_text().splitlines()]
    assert la == lb and a["steps"] == 6 and a["contributions_used"] == 2
    assert a["mix_weights"]["fon"] > a["mix_natural"]["fon"]
    audit = [json.loads(l) for l in (root / "reg/audit.jsonl").read_text().splitlines()]
    assert audit[0]["contribution_ids"] == ["c1", "c2"] and audit[0]["db_marked"] == "skipped:no_dsn" and audit[0]["steps"] == 6
    with pytest.raises(FileExistsError): retrain(_cfg(root, tok, vocab, "r1"), root=root, log=lambda *_: None)
    ev = registry.read(root / "reg/models.jsonl")
    assert [e["event"] for e in ev] == ["trained", "trained"] and ev[0]["files"]["checkpoint"]["sha256"]

def test_promotion_end_to_end_report_and_registry(world):
    root, tok, vocab = world
    retrain(_cfg(root, tok, vocab, "base"), root=root, log=lambda *_: None)
    retrain(_cfg(root, tok, vocab, "cand"), root=root, log=lambda *_: None)
    cfg = {"heldout": str(root / "data/sakc/v1/test.jsonl"), "registry": str(root / "reg/models.jsonl"), "reports_dir": str(root / "rep"),
           "baseline": {"id": "base", "checkpoint": str(root / "cand/base/last.pt"), "tokenizer": tok}, "gate": {"max_regression": 0.02}}
    fake = {"base": INC, "cand": {l: v - 0.05 for l, v in INC.items()}}
    scorer = lambda ck, tk, docs: {l: {"bpc": fake["base" if "/base/" in ck else "cand"][l], "docs": len(docs[l]), "chars": 1} for l in docs}
    r = promote.run(cfg, "cand", scorer=scorer)
    assert r["decision"]["promote"] and "NON PUBLIABLE" in r["publication"]
    assert [e["event"] for e in registry.read(root / "reg/models.jsonl")] == ["trained", "trained", "evaluated", "promoted"]
    assert registry.current_promoted(root / "reg/models.jsonl")["id"] == "cand"
    with pytest.raises(FileExistsError): promote.run(cfg, "cand", scorer=scorer)
    real = promote.bpc_per_lang(str(root / "cand/cand/last.pt"), tok, promote.load_heldout(root / "data/sakc/v1/test.jsonl"), threads=1)
    assert set(real) == set(LANGS) and all(v["bpc"] > 0 for v in real.values())
    cfg["heldout_sha256"] = "0" * 64
    with pytest.raises(RuntimeError): promote.run(cfg, "base", scorer=scorer)

def test_promotion_refused_on_regression_records_evaluated_only(world):
    root, tok, vocab = world
    retrain(_cfg(root, tok, vocab, "base"), root=root, log=lambda *_: None); retrain(_cfg(root, tok, vocab, "cand"), root=root, log=lambda *_: None)
    cfg = {"heldout": str(root / "data/sakc/v1/test.jsonl"), "registry": str(root / "reg/models.jsonl"), "reports_dir": str(root / "rep"),
           "baseline": {"id": "base", "checkpoint": str(root / "cand/base/last.pt"), "tokenizer": tok}}
    scorer = lambda ck, tk, docs: {l: {"bpc": INC[l] + (0 if "/base/" in ck else (0.05 if l == "yo" else -0.2))} for l in docs}
    r = promote.run(cfg, "cand", scorer=scorer)
    assert not r["decision"]["promote"] and "yo" in r["decision"]["reasons"][0]
    assert [e["event"] for e in registry.read(root / "reg/models.jsonl")][-1] == "evaluated"
    assert registry.current_promoted(root / "reg/models.jsonl") is None

# ------------------------------------------------------------------ migration 007
def test_007_is_additive():
    code = "\n".join(l.split("--")[0] for l in (DB / "migrations-ai/007_training_usage.sql").read_text().splitlines())
    assert not re.search(r"\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b", code, re.I)
    assert re.search(r"used_in_training_at IS NOT NULL", code)

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_007_marks_only_eligible_once_and_audit_is_append_only():
    import psycopg
    x = uuid.uuid4().hex[:8]
    with psycopg.connect(os.environ["SAKC_TEST_PG_DSN"], autocommit=True) as c:
        for f in sorted((DB / "migrations").glob("00*.sql")): c.execute(f.read_text())
        for f in sorted((DB / "migrations-ai").glob("00*.sql")): c.execute(f.read_text())
        c.execute((DB / "migrations-ai/007_training_usage.sql").read_text())  # idempotente
        uid = f"u{x}"
        c.execute("INSERT INTO users(id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','n','student','school')", (uid, f"{x}@t.io"))
        ver = c.execute("select version from contribution_consent_texts limit 1").fetchone()
        assert ver, "texte de consentement attendu (graine 006)"
        for i, st in ((1, "approved"), (2, "pending")):
            b = f"texte de test {x} {i}"
            c.execute("insert into contributions(contribution_id,contributor_id,kind,language,body,body_sha256,attribution,consent_version,consent_at,status,provenance)"
                      " values (%s,%s,'text','fon',%s,%s,'T',%s,now(),%s,'{}')", (f"c{x}{i}", uid, b, sha(b), ver[0], st))
        assert c.execute("select ai_mark_contributions_trained('run', %s, %s)", ([f"c{x}1", f"c{x}2"], "a" * 64)).fetchone()[0] == 1
        assert c.execute("select ai_mark_contributions_trained('run2', %s, %s)", ([f"c{x}1"], "b" * 64)).fetchone()[0] == 0
        rows = dict(c.execute("select contribution_id, used_in_training_at is not null from contributions where contribution_id like %s", (f"c{x}%",)).fetchall())
        assert rows == {f"c{x}1": True, f"c{x}2": False}
        oc = [r[0] for r in c.execute("select outcome from contribution_training_audit where contribution_id like %s order by audit_id", (f"c{x}%",))]
        assert oc == ["marked", "not_eligible", "already_marked"]
        with pytest.raises(psycopg.errors.RaiseException): c.execute("delete from contribution_training_audit where contribution_id = %s", (f"c{x}1",))
