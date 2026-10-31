import pathlib
from collections import Counter
from solob_ai.sakc import collect_v1 as C, pipeline
from solob_ai.sakc.schema import RightsStatus

def _story(tmp, lic, lang="Fongbe"):
    d = tmp / "repo" / "data"; d.mkdir(parents=True, exist_ok=True)
    (d / "1.txt").write_text(f"url:\thttp://x/1\nid:\t1\ntitle:\tT\nlang:\t{lang}\nlic:\t{lic}\n\npage_text:\n\nP1\t" + "Ayi " * 80 + "\n\nimages:\n")
    return C.load_asb(tmp, Counter())

def test_asb_cc_by_verified(tmp_path):
    r = _story(tmp_path, "Creative Commons: Attribution 4.0")[0]
    assert r.rights_status == RightsStatus.VERIFIED and r.license == "CC-BY-4.0" and r.language == "fon"

def test_asb_nc_blocked_by_gate(tmp_path):
    rs = _story(tmp_path, "Creative Commons: Attribution-Non Commercial 3.0")
    assert rs[0].rights_status == RightsStatus.REJECTED
    m = pipeline.run(rs, None); assert m["stats"]["bloque_droits"] == 1

def test_chunks_and_uniq():
    assert C.uniq(["a", "a ", "b"]) == ["a", "b"]
    assert len(list(C.chunks(["x" * 800] * 4, 1500))) == 2
