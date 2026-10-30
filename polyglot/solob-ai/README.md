# solob-ai — fondations IA SOLOB (Mission 2)

Python uniquement. Aucune donnée ni artefact n'est versionné (`data/`, `artifacts/` ignorés).

## Reproduire
```bash
uv venv --python 3.12 .venv
uv pip sync --python .venv/bin/python --require-hashes --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cpu requirements.lock
.venv/bin/python -m solob_ai.sakc.collect_hf_wikipedia        # Wikipedia CC BY-SA, ~2 Mo/langue
.venv/bin/python -m solob_ai.sakc.build                       # -> data/sakc/v0
.venv/bin/python -m solob_ai.toklab.run --corpus data/sakc/v0 # -> artifacts/toklab
.venv/bin/python -m solob_ai.model.data --tokenizer artifacts/toklab/unigram_8000.model
.venv/bin/python -m solob_ai.model.train configs/cpu.yaml     # -> artifacts/run_cpu_v0
.venv/bin/python -m solob_ai.evaluation.perplexity --ckpt artifacts/run_cpu_v0/last.pt \
  --data artifacts/data --corpus data/sakc/v0 --out artifacts/run_cpu_v0/ppl.json
.venv/bin/pytest -q
```
Migration optionnelle : `db/migrations-ai/004_sakc.sql` (additive, hors auto-application).
Voir `docs/` et `REPORT-MISSION2.md`.
