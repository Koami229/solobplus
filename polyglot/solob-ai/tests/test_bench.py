import copy, json, os, pathlib, subprocess, sys, pytest
from solob_ai.bench.schema import load_items, validate, TRACKS
from solob_ai.bench.metrics import exact_match, numeric, citation_support, abstention, rubric_proxy, parse_number
from solob_ai.bench.providers import StaticProvider
from solob_ai.bench.run import run, main, build_prompt
from solob_ai.bench.export import to_review, apply_validations, fetch_validated

ROOT = pathlib.Path(__file__).resolve().parents[1]; ITEMS = ROOT / "bench" / "items"
AI = ROOT.parents[1] / "db" / "migrations-ai"; MIG = ROOT.parents[1] / "db" / "migrations"

def items(): return load_items(ITEMS)

def test_seed_is_reproducible_and_valid(tmp_path):
    its = items()
    assert {i["track"] for i in its} == set(TRACKS)
    assert all(not validate(i) for i in its)
    assert all(i["author"] == "machine-draft" and i["status"] == "draft" and i["reviewer_ids"] == [] for i in its)
    before = {p.name: p.read_text() for p in ITEMS.glob("*.jsonl")}
    subprocess.run([sys.executable, str(ROOT / "bench" / "seed_items.py")], check=True, capture_output=True)
    assert before == {p.name: p.read_text() for p in ITEMS.glob("*.jsonl")}

def test_no_fabricated_national_language_text():
    for i in items():
        if i["language"] not in ("fr", "en"):
            assert i["needs_native_speaker"] and i["question"] is None and i["reference"] is None and i["translate_from"]

def test_schema_rejects_bad_items():
    i = next(x for x in items() if x["track"] == "mathematiques" and not x["needs_native_speaker"])
    j = dict(i, status="validated"); assert any("2 relecteurs" in e for e in validate(j))
    j = dict(i, license="CC-BY-NC-4.0"); assert validate(j)
    j = dict(i); j.pop("tolerance"); assert validate(j)
    j = dict(i, language="fon", needs_native_speaker=True, translate_from="x"); assert validate(j)  # texte présent -> refusé

def test_metrics():
    assert exact_match("Porto-Novo.", "Porto-Novo") == 1 and exact_match("Cotonou", "Porto-Novo") == 0
    assert exact_match("ɖé", "de") == 0  # diacritiques conservés
    assert parse_number("x = 1,25") == 1.25 and parse_number("5/4") == 1.25
    assert numeric("La réponse est 300 F", 300, 0.01) == 1 and numeric("301", 300, 0.01) == 0
    p = "Le mardi [citation: \"La cantine sert du riz le mardi\"]"
    s = citation_support(p, "La cantine sert du riz le mardi et des haricots le jeudi.", "le mardi")
    assert s["score"] == 1 and s["citation_supported"]
    assert citation_support("Le mardi [citation: \"riz le lundi soir\"]", "La cantine sert du riz le mardi.", "le mardi")["score"] == 0
    assert abstention("Ce pays n'existe pas.", "abstain")["score"] == 1
    assert abstention("Paris", "abstain")["score"] == 0
    assert abstention("56", "answer", "56")["score"] == 1
    r = rubric_proxy("La Terre tourne sur elle-même en 24 h", [{"criterion": "a", "keywords": ["tourne"], "points": 2},
                     {"criterion": "b", "keywords": ["moitié"], "points": 2}, {"criterion": "h", "human_only": True}])
    assert r["score"] == 0.5 and r["proxy"]

def _oracle(its):
    ans = {}
    for i in its:
        if i["needs_native_speaker"]: continue
        t = i["track"]; ref = i["reference"]
        if t == "fidelite_source":
            a = f"{ref} [citation: \"{i['passage'].split('. ')[-1].rstrip('.')}\"]"
        elif t == "hallucinations":
            a = {"abstain": "Je ne sais pas, cela n'existe pas.", "correct_premise": f"C'est faux : {ref}.", "answer": str(ref)}[i["expected_behavior"]]
        elif t == "qualite_explication": a = ref
        else: a = str(ref)
        ans[i["question"]] = a
    return StaticProvider(ans)

def test_oracle_scores_and_draft_is_not_publishable():
    its = items(); res = run(its, _oracle(its))
    assert res["publication"] == "NON PUBLIABLE" and res["raisons"]
    assert all(v["publication"] == "NON PUBLIABLE" for v in res["resultats"].values())
    assert res["items_non_traduits_ignores"] == sum(i["needs_native_speaker"] for i in its)
    low = [r for r in res["details"] if r["score"] < 1 and r["track"] != "qualite_explication"]
    assert not low, low
    assert all(r["score"] >= 0.6 for r in res["details"] if r["track"] == "qualite_explication")
    empty = run(its, StaticProvider(default=""))
    assert all(r["score"] == 0 for r in empty["details"])

def _validated(its):
    v = copy.deepcopy([i for i in its if not i["needs_native_speaker"]])
    for i in v: i["status"], i["reviewer_ids"] = "validated", ["r1", "r2"]
    return v

def test_publishable_only_when_validated_and_human_grades():
    v = _validated(items())
    assert run(v, _oracle(v))["publication"] == "NON PUBLIABLE"  # explications sans notes humaines
    hg = {i["item_id"]: 0.8 for i in v if i["track"] == "qualite_explication"}
    res = run(v, _oracle(v), hg); assert res["publication"] == "PUBLIABLE"
    one = copy.deepcopy(v); one[0]["status"] = "draft"
    assert run(one, _oracle(one), hg)["publication"] == "NON PUBLIABLE"

def test_cli_refuses_publish_on_drafts(capsys):
    assert main(["--items", str(ITEMS), "--provider", "v0", "--publish"]) == 2
    assert "REFUSÉE" in capsys.readouterr().err

def test_export_to_review_and_sync():
    its = items(); rows = to_review(its)
    assert len(rows) == len(its) and all(r["item_id"].startswith("bench:") for r in rows)
    kinds = {r["kind"] for r in rows}; assert kinds <= {"question", "explanation", "translation"}
    assert all(r["kind"] == "translation" for r, i in zip(rows, its) if i["needs_native_speaker"])
    c = copy.deepcopy(its); first = next(i for i in c if not i["needs_native_speaker"])
    assert apply_validations(c, {first["item_id"]: ["a"]}) == 0
    assert apply_validations(c, {first["item_id"]: ["a", "b", "a"]}) == 1 and first["reviewer_ids"] == ["a", "b"]
    nat = next(i for i in c if i["needs_native_speaker"])
    assert apply_validations(c, {nat["item_id"]: ["a", "b"]}) == 0

def test_prompts():
    i = next(x for x in items() if x["track"] == "fidelite_source" and not x["needs_native_speaker"])
    assert i["passage"] in build_prompt(i) and "citation" in build_prompt(i)

@pytest.mark.skipif(not os.environ.get("SAKC_TEST_PG_DSN"), reason="SAKC_TEST_PG_DSN non défini")
def test_bench_roundtrip_postgres():
    import psycopg
    dsn = os.environ["SAKC_TEST_PG_DSN"]
    with psycopg.connect(dsn, autocommit=True) as c:
        for f in sorted(MIG.glob("00*.sql")): c.execute(f.read_text())
        c.execute((AI / "004_sakc.sql").read_text()); c.execute((AI / "005_human_review.sql").read_text())
        for u in ("b1", "b2"):
            c.execute("INSERT INTO users(id,email,password_hash,full_name,role,pillar) VALUES (%s,%s,'x','n','teacher','business') ON CONFLICT DO NOTHING", (f"t6{u}", f"t6{u}@e.org"))
        its = items(); r = to_review(its)[0]
        c.execute("INSERT INTO ai_review_items(item_id,kind,language,source_ref,payload) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                  (r["item_id"], r["kind"], r["language"], r["source_ref"], json.dumps(r["payload"])))
        for n, u in enumerate(("t6b1", "t6b2")):
            c.execute("INSERT INTO ai_reviews(review_id,item_id,reviewer_id,decision) VALUES (%s,%s,%s,'accept') ON CONFLICT DO NOTHING", (f"t6r{n}", r["item_id"], u))
    got = fetch_validated(dsn); bid = r["item_id"].removeprefix("bench:")
    assert sorted(got[bid]) == ["t6b1", "t6b2"]
    assert apply_validations(its, got) >= 1 and next(i for i in its if i["item_id"] == bid)["status"] == "validated"
