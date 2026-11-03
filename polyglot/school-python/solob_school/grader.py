"""Calls the C++ grader (polyglot/grading-cpp, `solob-grade`) as a subprocess.
Choice: CLI over a ctypes/pybind binding — process isolation (a C++ fault cannot crash the Python worker),
no ABI/FFI memory-ownership risk, trivial deployment (one static binary), hard timeout. Cost: ~1–3 ms per spawn."""
from __future__ import annotations
import json, os, subprocess
from pathlib import Path
from .errors import AppError

DEFAULT_BIN = Path(__file__).resolve().parents[2] / "grading-cpp" / "build" / "solob-grade"

def _blob(s: str) -> bytes:
    b = s.encode("utf-8")
    return str(len(b)).encode() + b"\n" + b + b"\n"

def encode(questions: list[dict], answers: list[str], max_score: float) -> bytes:
    out = f"SOLOBGRADE1 {float(max_score)!r} {len(questions)}\n".encode()
    for q, a in zip(questions, answers):
        kws = [str(k).lower() for k in q.get("expectedKeywords", [])]
        out += f"{float(q.get('maxPoints', 0))!r} {len(kws)}\n".encode()
        for k in kws: out += _blob(k)
        # Lowercased here with Unicode rules (JS toLowerCase parity); C++ only lowercases ASCII.
        out += _blob(a.lower())
    return out

def grade(questions: list[dict], answers: list[str], max_score: float) -> dict:
    binary = os.environ.get("GRADER_BIN") or str(DEFAULT_BIN)
    try:
        r = subprocess.run([binary], input=encode(questions, answers, max_score), capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise AppError(503, "GRADER_UNAVAILABLE", "Grading engine is unavailable.")
    if r.returncode != 0:
        raise AppError(500, "GRADER_FAILED", "Grading engine rejected the input.")
    return json.loads(r.stdout)
