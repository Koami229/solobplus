import pathlib
from solob_ai.evaluation.benchmarks import load, score, Item, DISCIPLINES
ITEMS = load(pathlib.Path(__file__).parent.parent / "benchmarks" / "items.draft.jsonl")

def test_all_disciplines_present_and_all_draft():
    assert {i.discipline for i in ITEMS} == set(DISCIPLINES)
    assert all(i.review_status == "draft" and "NON VALIDÉ" in i.notes for i in ITEMS)

def test_drafts_never_count():
    r = score(ITEMS, {i.item_id: i.reference for i in ITEMS}); assert r["items_counted"] == 0 and "accuracy" not in r

def test_reviewed_counts_and_errors():
    i = Item(**{**ITEMS[0].__dict__, "review_status": "expert_reviewed", "reviewer": "ens-001", "reviewed_at": "2026-10-30"})
    bad = Item(**{**ITEMS[1].__dict__, "review_status": "expert_reviewed"})  # sans relecteur: exclu
    r = score([i, bad], {i.item_id: "1,25"}, {i.item_id: ["hallucination"]})
    assert r["items_counted"] == 1 and r["accuracy"] == 1.0 and r["error_rates"]["hallucination"] == 1.0
