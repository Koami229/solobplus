import json, os, pathlib, re, pytest
from solob_ai.review.agreement import cohen_kappa, pairs_from_reviews, interpret
from solob_ai.review import cli

AI = pathlib.Path(__file__).resolve().parents[3] / "db" / "migrations-ai"
MIG = AI.parent / "migrations"

def test_kappa_known_values():
    # Exemple classique: 50 items, accord observé 0.7, attendu 0.5 → kappa 0.4
    a = ["y"] * 20 + ["y"] * 5 + ["n"] * 10 + ["n"] * 15
    b = ["y"] * 20 + ["n"] * 5 + ["y"] * 10 + ["n"] * 15
    assert abs(cohen_kappa(a, b) - 0.4) < 1e-9
    assert cohen_kappa(["a", "b"], ["a", "b"]) == 1.0
    assert cohen_kappa(["a", "a"], ["a", "a"]) == 1.0
    assert cohen_kappa([], []) is None
    with pytest.raises(ValueError): cohen_kappa(["a"], [])
    assert interpret(0.4) == "modéré" and interpret(None) == "non défini"

def test_pairs_use_two_earliest_reviews():
    rows = [("i1", "r2", "reject", 2), ("i1", "r1", "accept", 1), ("i1", "r3", "accept", 3), ("i2", "r1", "accept", 1)]
    assert pairs_from_reviews(rows) == (["accept"], ["reject"])

def test_export_items(tmp_path):
    v = tmp_path / "v1"; (v / "quality").mkdir(parents=True)
    docs = [{"sha256": c * 64, "language": "fon", "title": "t", "text": "x" * 10, "url": "https://u", "license": "CC0-1.0"} for c in "ab"]
    (v / "educational.jsonl").write_text("\n".join(json.dumps(d) for d in docs) + "\n")
    (v / "quality" / "flags.jsonl").write_text(json.dumps({"sha256": "b" * 64, "flags": ["f"]}) + "\n")
    items = cli.build_items(v, per_lang=1)
    assert len(items) == 1 and items[0]["sakc_sha256"] == "b" * 64 and items[0]["payload"]["quality_flags"] == ["f"]
    assert items[0]["kind"] in cli.KINDS

def test_kappa_cli_from_file(tmp_path, capsys):
    f = tmp_path / "r.jsonl"
    rows = [("i1", "a", "accept", "1"), ("i1", "b", "accept", "2"), ("i2", "a", "reject", "1"), ("i2", "b", "accept", "2")]
    f.write_text("".join(json.dumps({"item_id": i, "reviewer_id": r, "decision": d, "created_at": t, "kind": "resource", "language": "fon"}) + "\n" for i, r, d, t in rows))
    cli.main(["kappa", "--reviews", str(f)])
    out = json.loads(capsys.readouterr().out)
    assert out["items_double_relus"] == 2 and out["kappa"] == 0.0

def test_005_is_additive():
    code = "\n".join(l.split("--")[0] for l in (AI / "005_human_review.sql").read_text().splitlines())
    assert not re.search(r"\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b", code, re.I)

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_005_on_postgres():
    import psycopg, uuid
    x = uuid.uuid4().hex[:8]  # identifiants uniques: test rejouable sur une base déjà utilisée (audit append-only)
    with psycopg.connect(os.environ["SAKC_TEST_PG_DSN"], autocommit=True) as c:
        for f in sorted(MIG.glob("00*.sql")): c.execute(f.read_text())
        for _ in range(2):  # idempotente
            c.execute((AI / "004_sakc.sql").read_text()); c.execute((AI / "005_human_review.sql").read_text())
        for u in ("u1", "u2", "u3"):
            c.execute("INSERT INTO users(id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','n','reviewer','business') ON CONFLICT DO NOTHING", (f"t5{x}{u}", f"t5{x}{u}@e.org"))
        for it in (f"t5{x}a", f"t5{x}b", f"t5{x}c"):
            c.execute("INSERT INTO ai_review_items(item_id,kind,language,source_ref,payload) VALUES (%s,'translation','fon','t','{}') ON CONFLICT DO NOTHING", (it,))
        ins = "INSERT INTO ai_reviews(review_id,item_id,reviewer_id,decision) VALUES (%s,%s,%s,%s)"
        c.execute(ins, (f"t5{x}r1", f"t5{x}a", f"t5{x}u1", "accept"))
        assert c.execute("SELECT status FROM ai_review_items WHERE item_id=%s", (f"t5{x}a",)).fetchone()[0] == "in_review"
        c.execute(ins, (f"t5{x}r2", f"t5{x}a", f"t5{x}u2", "accept"))
        assert c.execute("SELECT status FROM ai_review_items WHERE item_id=%s", (f"t5{x}a",)).fetchone()[0] == "validated"
        with pytest.raises(psycopg.errors.UniqueViolation): c.execute(ins, (f"t5{x}r3", f"t5{x}a", f"t5{x}u1", "reject"))
        c.execute(ins, (f"t5{x}r4", f"t5{x}b", f"t5{x}u1", "accept")); c.execute(ins, (f"t5{x}r5", f"t5{x}b", f"t5{x}u2", "reject"))
        assert c.execute("SELECT status FROM ai_review_items WHERE item_id=%s", (f"t5{x}b",)).fetchone()[0] == "disputed"
        c.execute(ins, (f"t5{x}r6", f"t5{x}c", f"t5{x}u1", "reject")); c.execute(ins, (f"t5{x}r7", f"t5{x}c", f"t5{x}u3", "reject"))
        assert c.execute("SELECT status FROM ai_review_items WHERE item_id=%s", (f"t5{x}c",)).fetchone()[0] == "rejected"
        with pytest.raises(psycopg.errors.CheckViolation): c.execute(ins, (f"t5{x}r8", f"t5{x}c", f"t5{x}u2", "maybe"))
        k = c.execute("SELECT items_double_relus, kappa FROM ai_review_agreement WHERE kind='translation' AND language='fon'").fetchone()
        a = [r[0] for r in c.execute("SELECT decision_1 FROM ai_review_pairs WHERE kind='translation' AND language='fon' ORDER BY item_id")]
        b = [r[0] for r in c.execute("SELECT decision_2 FROM ai_review_pairs WHERE kind='translation' AND language='fon' ORDER BY item_id")]
        assert k[0] == len(a) and abs(k[1] - cohen_kappa(a, b)) < 1e-9
        assert c.execute("SELECT COUNT(*) FROM ai_review_audit WHERE item_id LIKE %s", (f"t5{x}%",)).fetchone()[0] >= 6
        with pytest.raises(psycopg.errors.RaiseException): c.execute("DELETE FROM ai_review_audit WHERE item_id=%s", (f"t5{x}a",))
