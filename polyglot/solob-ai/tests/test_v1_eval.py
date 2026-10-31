"""Tests unitaires: métriques tokenizer v1 (diacritiques tonals, roundtrip) et BPC exact (fenêtre partielle incluse)."""
import torch
from solob_ai.toklab.v1 import marks, evaluate, EXCLUDE_FLAGS
from solob_ai.toklab.lab import train_tokenizer
from solob_ai.evaluation.bpc_common import nll_bits
from solob_ai.model.config import ModelConfig
from solob_ai.model.gpt import GPT

def test_marks_counts_tones_and_special_letters():
    m = marks("Ọmọ ń lọ ɖò")
    assert sum(m.values()) >= 5 and "\u0323" in m and "ɖ" in m

def test_exclusion_flags_documented():
    assert EXCLUDE_FLAGS == {"gabarit_dominant", "stub_court_wikipedia"}

def test_evaluate_preserves_yoruba_tones():
    texts = ["Ọmọ náà ń lọ sí ilé ìwé. Àwọn ọmọdé ń kọ́ ẹ̀kọ́."] * 200
    tok = train_tokenizer("unigram", texts, 300)
    r = evaluate(tok, ["Ọmọ náà ń lọ sí ilé ìwé.\nÀwọn  ọmọdé"], "yo")
    assert r["diacritics_preserved"] == 1.0 and r["unk_rate"] == 0.0 and r["roundtrip_modulo_whitespace"] == 1.0

def test_nll_bits_counts_every_predicted_token():
    torch.manual_seed(0); m = GPT(ModelConfig(vocab_size=50, d_model=16, n_layers=1, n_heads=2, d_ff=32, max_seq_len=8, dropout=0.0)); m.eval()
    ids = list(range(1, 22))  # 21 tokens -> 20 prédictions, fenêtres 8+8+4
    bits, n = nll_bits(m, ids, 8)
    assert n == 20 and bits > 0
