"""Exécute tous les contrôles qualité sur une version SAKC et écrit des fichiers de drapeaux.
Usage: python -m solob_ai.sakc.quality.run data/sakc/v1 [--no-langid]
Sorties (dans <version>/quality/): flags.jsonl (1 ligne/doc ayant ≥1 drapeau), scores.jsonl, SUMMARY.json.
Aucun document n'est supprimé ni modifié."""
from __future__ import annotations
import argparse, json, pathlib, statistics
from collections import Counter, defaultdict
from datasketch import MinHashLSH
from .. import pipeline
from . import checks as C

AFROLID = {"fon": {"fon"}, "yo": {"yor"}, "ha": {"hau"}, "wo": {"wol"}, "sw": {"swh", "swa", "swc"}, "ig": {"ibo"}}

def load(vdir: pathlib.Path):
    docs = []
    for split in ("train", "val", "test"):
        for line in (vdir / f"{split}.jsonl").open(encoding="utf-8"):
            d = json.loads(line); d["_split"] = split; docs.append(d)
    return docs

def proof_resolver(raw: pathlib.Path):
    def ok(ref: str) -> bool:
        base = ref.split("#")[0]
        return any((p / base).exists() for p in (raw, raw / "wikipedia"))
    return ok

def templates_by_source(docs, n=6, min_docs=20, min_frac=0.02):
    df = defaultdict(Counter); size = Counter()
    for d in docs:
        size[d["source_id"]] += 1; df[d["source_id"]].update(C.ngrams(d["text"], n))
    return {s: {g for g, c in cnt.items() if c >= max(min_docs, min_frac * size[s])} for s, cnt in df.items()}

def cross_split_near_dups(docs, threshold=0.8):
    lsh = MinHashLSH(threshold=threshold, num_perm=64); hits = {}
    for i, d in enumerate(docs):
        if d["_split"] == "train": lsh.insert(str(i), pipeline.minhash(d["text"]))
    for i, d in enumerate(docs):
        if d["_split"] != "train":
            m = lsh.query(pipeline.minhash(d["text"]))
            if m: hits[i] = [docs[int(j)]["sha256"][:12] for j in m[:3]]
    return hits

def afrolid(docs, model_dir="artifacts/afrolid/afrolid_1.5"):
    import torch; torch.set_num_threads(6)
    from transformers import pipeline as hfp
    clf = hfp("text-classification", model=model_dir, use_fast=False, device=-1)
    idx = [i for i, d in enumerate(docs) if d["language"] in AFROLID]
    preds = clf([docs[i]["text"][:1000] for i in idx], batch_size=16, truncation=True, max_length=256, top_k=1)
    return {i: (p[0] if isinstance(p, list) else p) for i, p in zip(idx, preds)}

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("vdir"); ap.add_argument("--raw", default="data/raw")
    ap.add_argument("--no-langid", action="store_true"); a = ap.parse_args(argv)
    vdir = pathlib.Path(a.vdir); out = vdir / "quality"; out.mkdir(exist_ok=True)
    docs = load(vdir); has_proof = proof_resolver(pathlib.Path(a.raw))
    tpl = templates_by_source(docs); dups = cross_split_near_dups(docs)
    lid = {} if a.no_langid else afrolid(docs)
    fc, by_src, by_lang, scores = Counter(), defaultdict(Counter), defaultdict(Counter), defaultdict(list)
    n_flagged = 0; ttr_all = defaultdict(list)
    with (out / "flags.jsonl").open("w", encoding="utf-8") as ff, (out / "scores.jsonl").open("w", encoding="utf-8") as fs:
        for i, d in enumerate(docs):
            t, lang, src = d["text"], d["language"], d["source_id"]
            f = C.repetition_flags(t) + C.bot_pattern_flags(t, src)
            ld = C.lexical_diversity(t)
            if ld is not None:
                ttr_all[lang].append(ld)
                if ld < 0.35: f.append("diversite_lexicale_faible")
            cov = C.template_coverage(t, tpl.get(src, set()))
            if cov > 0.5: f.append("gabarit_dominant")
            elif cov > 0.25: f.append("gabarit_partiel")
            if src == "google-smol": f.append("origine_source_generee_llm_traduite_humain")
            if i in dups: f.append("quasi_doublon_inter_split")
            if i in lid:
                p = lid[i]
                if p["label"] not in AFROLID[lang]: f.append(f"langid_desaccord:{p['label']}")
                elif p["score"] < 0.5: f.append("langid_confiance_faible")
            f += C.orthography_flags(t, lang) + C.script_flags(t, lang) + C.license_flags(d) + C.provenance_flags(d, has_proof)
            sc, parts = C.pedagogy_score(d); scores[(src, lang)].append(sc)
            fs.write(json.dumps({"sha256": d["sha256"], "split": d["_split"], "source_id": src, "language": lang,
                                 "pedagogy_score": sc, "parts": parts, "template_coverage": round(cov, 3),
                                 "ttr300": None if ld is None else round(ld, 3)}, ensure_ascii=False) + "\n")
            if f:
                n_flagged += 1
                ff.write(json.dumps({"sha256": d["sha256"], "split": d["_split"], "source_id": src, "language": lang,
                                     "title": d.get("title", ""), "flags": f, "dup_of": dups.get(i)}, ensure_ascii=False) + "\n")
            for x in f:
                k = x.split(":")[0]; fc[k] += 1; by_src[src][k] += 1; by_lang[lang][k] += 1
    summ = {"version": vdir.name, "documents": len(docs), "documents_signales": n_flagged, "langid_execute": not a.no_langid,
            "drapeaux": dict(fc.most_common()), "par_source": {k: dict(v) for k, v in sorted(by_src.items())},
            "par_langue": {k: dict(v) for k, v in sorted(by_lang.items())},
            "ttr300_median_par_langue": {k: round(statistics.median(v), 3) for k, v in sorted(ttr_all.items())},
            "score_pedagogique": {f"{s}|{l}": {"n": len(v), "median": statistics.median(v), "p90": sorted(v)[int(0.9 * (len(v) - 1))]}
                                  for (s, l), v in sorted(scores.items())},
            "gabarits_par_source": {s: len(g) for s, g in sorted(tpl.items())}}
    (out / "SUMMARY.json").write_text(json.dumps(summ, ensure_ascii=False, indent=1))
    print(json.dumps({k: summ[k] for k in ("documents", "documents_signales", "drapeaux")}, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
