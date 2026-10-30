"""Tests par langue: chaque tokenizer entraîné sur un mini-échantillon multilingue doit restituer
exactement (aller-retour) des phrases caractéristiques, rester stable NFC, et couvrir les caractères
spéciaux (ɖ ɔ ɛ ẹ ọ ṣ ƙ ɗ ɓ ŋ ñ ë ụ ị, tons combinants). Ces phrases sont des fixtures techniques, pas
une évaluation linguistique."""
import unicodedata, pytest
from solob_ai.toklab.lab import train_tokenizer, metrics
import collections

FIX = {
    "fr": "L'élève étudie la géométrie à l'école de Porto-Novo.",
    "en": "The students learn mathematics and history at school.",
    "fon": "Ɛ ɖò xɔ̀ mɛ. Mi kú ɖè ɖò Gbɛ̀ ɔ mɛ.",
    "yo": "Ẹ kú àárọ̀. Ọmọ náà ń kọ́ ẹ̀kọ́ ní ilé-ìwé. Ṣé dáadáa ni?",
    "ha": "Ina kwana? Ɗan makaranta yana karatu a ƙasar Najeriya. Ɓera.",
    "wo": "Na nga def? Ñaari xale yi ngi jàng ci daara bi. Ŋoon. Ëllëg.",
    "sw": "Habari ya asubuhi. Wanafunzi wanasoma shuleni. Ng'ombe.",
    "ig": "Kedụ ka ị mere? Ụmụaka na-agụ akwụkwọ n'ụlọ akwụkwọ.",
}
CORPUS = [unicodedata.normalize("NFC", s) * 30 for s in FIX.values()]
TOKS = {k: train_tokenizer(k, CORPUS, 500) for k in ("bpe", "unigram", "bytebpe")}

@pytest.mark.parametrize("kind", list(TOKS))
@pytest.mark.parametrize("lang", list(FIX))
def test_roundtrip_and_nfc(kind, lang):
    tok, s = TOKS[kind], unicodedata.normalize("NFC", FIX[lang])
    assert tok.decode(tok.ids(s)).strip() == s
    assert tok.unk_count(s) == 0
    if kind != "unigram":  # bpe/bytebpe normalisent NFC: NFD et NFC doivent donner les mêmes tokens
        assert tok.ids(unicodedata.normalize("NFD", s)) == tok.ids(s)

@pytest.mark.parametrize("lang", list(FIX))
def test_metrics_shape(lang):
    m = metrics(TOKS["bytebpe"], FIX[lang], collections.Counter())
    assert m["char_coverage"] == 1.0 and m["tokens"] > 0 and m["tokens_per_word"] > 0
