import json
from solob_ai.sakc.schema import Resource, RightsStatus
from solob_ai.sakc import pipeline

TXT = ("Le Bénin est un pays d'Afrique de l'Ouest. Sa capitale est Porto-Novo et sa plus grande ville "
       "est Cotonou. Le fon, le yoruba et le français y sont parlés. ") * 3

def R(text, status=RightsStatus.VERIFIED, lic="CC-BY-SA-4.0", lang="fr", **kw):
    return Resource(source_id="s", url="https://x/" + str(hash(text)), license=lic, rights_status=status,
                    proof_ref="p.json", country="BJ", language=lang, text=text, **kw)

def test_rights_gate_blocks_unverified():
    m = pipeline.run([R(TXT, RightsStatus.UNKNOWN), R(TXT + "b", RightsStatus.PENDING),
                      R(TXT + "c", RightsStatus.REJECTED)], None)
    assert sum(len(v) for v in m["_splits"].values()) == 0 and m["stats"]["bloque_droits"] == 3

def test_verified_with_closed_license_is_schema_error():
    m = pipeline.run([R(TXT, lic="ALL-RIGHTS-RESERVED")], None)
    assert m["stats"]["schema_invalide"] == 1

def test_exact_and_near_duplicates():
    long = " ".join(f"phrase{i} sur l'histoire du royaume du Danxomè" for i in range(80))
    near = long.replace("phrase7 ", "phrase7bis ")
    m = pipeline.run([R(long), R(long), R(near), R("Un texte complètement différent sur la photosynthèse des plantes vertes. " * 6)], None)
    assert m["stats"]["doublon_exact"] == 1 and m["stats"]["quasi_doublon"] == 1
    assert sum(len(v) for v in m["_splits"].values()) == 2

def test_nfc_normalisation():
    nfd = "ɖ" + "e\u0301" + " ẹ".replace("ẹ", "e\u0323")
    assert pipeline.clean(nfd) == "ɖé ẹ"

def test_qc_rejects_short():
    assert pipeline.run([R("court")], None)["stats"]["qc_trop_court"] == 1

def test_split_deterministic_and_disjoint(tmp_path):
    docs = [R(f"Document numéro {i} " + "mot%d " % i * 60 + TXT[:i]) for i in range(200)]
    m1 = pipeline.run(docs, tmp_path / "a"); 
    docs2 = [R(f"Document numéro {i} " + "mot%d " % i * 60 + TXT[:i]) for i in reversed(range(200))]
    m2 = pipeline.run(docs2, tmp_path / "b")
    for s in ("train", "val", "test"):
        assert {r.sha256 for r in m1["_splits"][s]} == {r.sha256 for r in m2["_splits"][s]}
    tr = {r.sha256 for r in m1["_splits"]["train"]}; te = {r.sha256 for r in m1["_splits"]["test"]}
    assert not tr & te
    man = json.loads((tmp_path / "a" / "MANIFEST.json").read_text())
    assert man["version"] == "v0" and len(man["shards"]["train"]["sha256"]) == 64

def test_trace_log(tmp_path):
    p = tmp_path / "t.jsonl"; pipeline.run([R(TXT), R(TXT, RightsStatus.UNKNOWN)], None, trace_path=p)
    ev = [json.loads(l)["event"] for l in p.read_text().splitlines()]
    assert ev == ["accepte", "bloque_droits"]
