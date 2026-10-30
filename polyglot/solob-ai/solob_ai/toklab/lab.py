"""Laboratoire tokenizer SOLOB AI: BPE (caractères), Unigram SentencePiece et BPE par octets,
à plusieurs tailles de vocabulaire, évalués par langue sur le split test de SAKC."""
from __future__ import annotations
import json, pathlib, unicodedata, collections, tempfile, io
import sentencepiece as spm
from tokenizers import Tokenizer, models, trainers, pre_tokenizers, normalizers, decoders

LANGS = ["fr", "en", "fon", "yo", "ha", "wo", "sw", "ig"]
SPECIAL = ["<pad>", "<unk>", "<bos>", "<eos>"] + [f"<lang_{l}>" for l in LANGS]
TONE_CHARS = "ɖɔɛẹọṣƙɗɓŋàáèéìíòóùúǹńẹ̀ọ́"
# Paires de variantes orthographiques (forme soignée, forme simplifiée courante à l'écrit numérique).
VARIANTS = {
    "yo": [("Yorùbá", "Yoruba"), ("ẹ̀kọ́", "eko"), ("ọmọ", "omo"), ("Ọlọ́run", "Olorun")],
    "fon": [("ɖò", "do"), ("Gbɛ̀", "Gbe"), ("mɔ̌", "mo")],
    "ha": [("ƙasa", "kasa"), ("ɗan", "dan"), ("ɓera", "bera")],
    "ig": [("Ụ̀wà", "Uwa"), ("ọ̀kụ̀", "oku"), ("ndị", "ndi")],
    "wo": [("ñaari", "naari"), ("ŋoon", "ngoon"), ("ëllëg", "elleg")],
    "sw": [("shule", "shule"), ("ng'ombe", "ngombe")],
    "fr": [("élève", "eleve"), ("français", "francais")],
    "en": [("colour", "color"), ("centre", "center")],
}

class Tok:
    def __init__(self, kind, obj): self.kind, self.obj = kind, obj
    def encode(self, s): return self.obj.encode(s, out_type=str) if self.kind == "unigram" else self.obj.encode(s).tokens
    def ids(self, s): return self.obj.encode(s) if self.kind == "unigram" else self.obj.encode(s).ids
    def decode(self, ids): return self.obj.decode(ids)
    def vocab_size(self): return self.obj.get_piece_size() if self.kind == "unigram" else self.obj.get_vocab_size()
    def unk_count(self, s):
        if self.kind == "unigram": return self.obj.encode(s).count(self.obj.unk_id())
        if self.kind == "bytebpe": return 0
        return self.obj.encode(s).tokens.count("<unk>")
    def save(self, path: pathlib.Path):
        if self.kind == "unigram": path.with_suffix(".model").write_bytes(self.obj.serialized_model_proto())
        else: self.obj.save(str(path.with_suffix(".json")))

def train_tokenizer(kind: str, texts: list[str], vocab: int) -> Tok:
    if kind == "unigram":
        buf = io.BytesIO()
        spm.SentencePieceTrainer.train(sentence_iterator=iter([l for t in texts for l in t.splitlines() if l.strip()]),
            model_writer=buf, vocab_size=vocab, model_type="unigram", character_coverage=1.0,
            normalization_rule_name="nfkc_cf" if False else "identity", byte_fallback=True,
            user_defined_symbols=SPECIAL[4:], hard_vocab_limit=False, minloglevel=2,
            pad_id=0, unk_id=1, bos_id=2, eos_id=3, input_sentence_size=2_000_000, shuffle_input_sentence=True,
            seed_sentencepiece_size=200000, num_threads=4)
        sp = spm.SentencePieceProcessor(); sp.load_from_serialized_proto(buf.getvalue()); return Tok(kind, sp)
    if kind == "bpe":
        t = Tokenizer(models.BPE(unk_token="<unk>"))
        t.normalizer = normalizers.NFC()
        t.pre_tokenizer = pre_tokenizers.Metaspace(); t.decoder = decoders.Metaspace()
        tr = trainers.BpeTrainer(vocab_size=vocab, special_tokens=SPECIAL, min_frequency=2)
    elif kind == "bytebpe":
        t = Tokenizer(models.BPE())
        t.normalizer = normalizers.NFC()
        t.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False); t.decoder = decoders.ByteLevel()
        tr = trainers.BpeTrainer(vocab_size=vocab, special_tokens=SPECIAL, min_frequency=2,
                                 initial_alphabet=pre_tokenizers.ByteLevel.alphabet())
    else: raise ValueError(kind)
    t.train_from_iterator(texts, tr); return Tok(kind, t)

def words(s): return s.split()

def metrics(tok: Tok, test: str, train_counts: collections.Counter) -> dict:
    ids = tok.ids(test); n_tok = max(1, len(ids)); ws = words(test)
    rare = [w for w in ws if train_counts[w] <= 1][:3000]
    rare_tok = sum(len(tok.ids(w)) for w in rare)
    chars = set(test) - {" ", "\n"}
    uncovered = [c for c in chars if tok.unk_count(c) > 0]
    sample = test[:20000]
    rt = tok.decode(tok.ids(sample))
    nfd = unicodedata.normalize("NFD", sample)
    return {"chars": len(test), "words": len(ws), "tokens": n_tok,
            "chars_per_token": round(len(test) / n_tok, 3), "bytes_per_token": round(len(test.encode()) / n_tok, 3),
            "tokens_per_word": round(n_tok / max(1, len(ws)), 3),
            "rare_words": len(rare), "tokens_per_rare_word": round(rare_tok / max(1, len(rare)), 3),
            "char_coverage": round(1 - len(uncovered) / max(1, len(chars)), 4), "uncovered_chars": "".join(sorted(uncovered))[:40],
            "unk_rate": round(tok.unk_count(test[:200000]) / max(1, len(tok.ids(test[:200000]))), 5),
            "roundtrip_exact": rt.strip() == sample.strip(),
            "nfd_token_inflation": round(len(tok.ids(nfd)) / max(1, len(tok.ids(sample))), 3),
            "tokens_per_1k_chars": round(1000 * n_tok / max(1, len(test)), 1)}

def variant_cost(tok: Tok, lang: str) -> list:
    return [{"careful": a, "simple": b, "tok_careful": len(tok.ids(a)), "tok_simple": len(tok.ids(b))} for a, b in VARIANTS.get(lang, [])]
