"""Tokenizer v1: entraînement sur SAKC v1 train (filtré par les drapeaux qualité) et comparaison au tokenizer v0
sur des ensembles held-out FIXES par langue (SAKC v1 test, qui contient tout le test v0).
Usage: python -m solob_ai.toklab.v1 --vocabs 8000,16000,32000
Le tokenizer v0 (artifacts/toklab/unigram_8000.model) est seulement LU."""
from __future__ import annotations
import argparse, collections, hashlib, json, pathlib, resource, time, unicodedata
import sentencepiece as spm
from .lab import LANGS, Tok, train_tokenizer

EXCLUDE_FLAGS = {"gabarit_dominant", "stub_court_wikipedia"}
TONE_LANGS = {"fon", "yo"}

def excluded_shas(flags_path):
    ex = {}
    for l in open(flags_path, encoding="utf-8"):
        d = json.loads(l); hit = EXCLUDE_FLAGS.intersection(f.split(":")[0] for f in d["flags"])
        if hit and d["split"] == "train": ex[d["sha256"]] = sorted(hit)
    return ex

def train_texts(corpus, excl, cap):
    by = collections.defaultdict(list); dropped = collections.Counter()
    for l in open(corpus / "train.jsonl", encoding="utf-8"):
        d = json.loads(l)
        if d["sha256"] in excl: dropped[d["language"]] += 1; continue
        by[d["language"]].append(d)
    texts, stats = [], {}
    for lang in LANGS:
        docs = sorted(by[lang], key=lambda d: hashlib.sha256(("tokv1" + d["sha256"]).encode()).hexdigest())  # mélange stable
        s, used = 0, 0
        for d in docs:
            if s >= cap: break
            t = d["text"][: cap - s]; texts.append(t); s += len(t); used += 1
        stats[lang] = {"docs_dispo": len(docs), "docs_exclus": dropped[lang], "docs_utilises": used, "chars_utilises": s}
    return texts, stats

def heldout(corpus):
    by = collections.defaultdict(list)
    for l in open(corpus / "test.jsonl", encoding="utf-8"):
        d = json.loads(l); by[d["language"]].append(d["text"])
    return by

def marks(s):  # diacritiques combinants + lettres spéciales (ɖ ɛ ɔ ẹ ọ ṣ ...) après NFD
    n = unicodedata.normalize("NFD", s)
    return collections.Counter(c for c in n if unicodedata.combining(c) or (ord(c) > 0x24F and c.isalpha()))

def evaluate(tok: Tok, texts: list[str], lang: str) -> dict:
    sp = tok.obj; lines = [x for t in texts for x in t.split("\n") if x.strip()]
    chars = sum(len(x) for x in lines); n_tok = unk = byte_fb = rt_ok = rt_ws = 0; m_in = collections.Counter(); m_out = collections.Counter()
    for x in lines:
        ids = sp.encode(x); n_tok += len(ids); unk += ids.count(sp.unk_id())
        byte_fb += sum(1 for i in ids if sp.is_byte(i))
        y = sp.decode(ids); rt_ok += (y == x); rt_ws += (" ".join(y.split()) == " ".join(x.split()))
        if lang in TONE_LANGS: m_in.update(marks(x)); m_out.update(marks(y))
    r = {"lines": len(lines), "chars": chars, "tokens": n_tok, "chars_per_token": round(chars / max(1, n_tok), 3),
         "unk_rate": round(unk / max(1, n_tok), 6), "byte_fallback_rate": round(byte_fb / max(1, n_tok), 5),
         "roundtrip_exact_lines": round(rt_ok / max(1, len(lines)), 5),
         "roundtrip_modulo_whitespace": round(rt_ws / max(1, len(lines)), 5)}  # SentencePiece fusionne les espaces multiples / de bord
    if lang in TONE_LANGS:
        tot = sum(m_in.values()); kept = sum(min(m_in[c], m_out[c]) for c in m_in)
        r["diacritics_total"] = tot; r["diacritics_preserved"] = round(kept / max(1, tot), 5)
    return r

def load_sp(path):
    sp = spm.SentencePieceProcessor(model_file=str(path)); return Tok("unigram", sp)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--corpus", default="data/sakc/v1")
    ap.add_argument("--flags", default="data/sakc/v1/quality/flags.jsonl"); ap.add_argument("--cap", type=int, default=2_000_000)
    ap.add_argument("--vocabs", default="8000,16000,32000"); ap.add_argument("--v0", default="artifacts/toklab/unigram_8000.model")
    ap.add_argument("--out", default="artifacts/toklab_v1"); a = ap.parse_args()
    corpus, out = pathlib.Path(a.corpus), pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    v0_sha = hashlib.sha256(pathlib.Path(a.v0).read_bytes()).hexdigest()
    excl = excluded_shas(a.flags); texts, stats = train_texts(corpus, excl, a.cap); ho = heldout(corpus)
    res = {"heldout": "data/sakc/v1/test.jsonl (contient le test v0)", "exclusion_flags": sorted(EXCLUDE_FLAGS),
           "train_cap_chars_per_lang": a.cap, "train_stats": stats, "runs": []}
    toks = [("v0_unigram_8000", load_sp(a.v0), None)]
    for v in map(int, a.vocabs.split(",")):
        t0 = time.time(); tk = train_tokenizer("unigram", texts, v); dt = round(time.time() - t0, 1)
        tk.save(out / f"unigram_{v}"); toks.append((f"v1_unigram_{v}", load_sp(out / f"unigram_{v}.model"), dt)); print("trained", v, dt, flush=True)
    for name, tk, dt in toks:
        res["runs"].append({"name": name, "vocab": tk.vocab_size(), "train_seconds": dt,
                            "langs": {l: evaluate(tk, ho[l], l) for l in LANGS if ho.get(l)}}); print("eval", name, flush=True)
    assert hashlib.sha256(pathlib.Path(a.v0).read_bytes()).hexdigest() == v0_sha, "tokenizer v0 modifié !"
    res["peak_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    (out / "results.json").write_text(json.dumps(res, ensure_ascii=False, indent=1)); print("ok")
