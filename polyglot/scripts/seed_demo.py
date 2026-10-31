#!/usr/bin/env python3
"""SOLOB+ full-chain DEMO seed (Core admin + School + Business), through the gateway API only.

* Every account, organisation and text is clearly fake: emails end in @synthetic.solob.local,
  names/titles are prefixed with [SYNTHETIC]. Never use it with real people's data.
* Idempotent: the gateway's `seed_synthetic` action is a no-op once seeded; the extra steps here are
  upserts (school profile, talent profile). Re-running never duplicates rows.
* Non-destructive: no DELETE/TRUNCATE/DROP; only additive API calls.
* Refused by the gateway when APP_ENV=production (SEED_FORBIDDEN_IN_PRODUCTION) — by design.

Usage (stdlib only):
  SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... python3 seed_demo.py [--gateway http://127.0.0.1:8100]
The admin is the one created once with `solob-gateway bootstrap-admin` (see polyglot/SMOKE.md).
"""
import argparse
import os
import sys

from solob_client import Gateway

SYNTHETIC_PASSWORD = "SolobSynthetic#2026"  # public, documented demo password (synthetic accounts only)
ACCOUNTS = {
    "student": "student.amina@synthetic.solob.local",
    "teacher": "teacher.mensah@synthetic.solob.local",
    "org_client": "client.waxangari@synthetic.solob.local",
    "contributor": "talent.fifame@synthetic.solob.local",
    "contributor2": "talent.adebayo@synthetic.solob.local",
    "reviewer": "reviewer.kossi@synthetic.solob.local",
    "operator": "operator.solob@synthetic.solob.local",
    "admin": "admin@synthetic.solob.local",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gateway", default=os.environ.get("GATEWAY_URL", "http://127.0.0.1:8100"))
    a = ap.parse_args()
    email, pwd = os.environ.get("SEED_ADMIN_EMAIL"), os.environ.get("SEED_ADMIN_PASSWORD")
    if not email or not pwd:
        print("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required (bootstrap admin).", file=sys.stderr)
        return 2
    failures: list[str] = []

    def check(label: str, ok: bool, detail: object = "") -> None:
        print(("OK   " if ok else "FAIL ") + label + ("" if ok else f" -> {detail}"))
        if not ok:
            failures.append(label)

    g = Gateway(a.gateway)
    st, r = g.login(email, pwd)
    check("core: bootstrap admin login", st == 200, (st, r))
    if st != 200:
        return 1
    st, r = g.call("POST", "/api/admin", {"action": "seed_synthetic"})
    check("core: seed_synthetic (accounts + flags + school/business baseline)", st == 200 and r.get("seeded"), (st, r))
    print(f"     alreadySeeded={r.get('alreadySeeded')} pillarData={r.get('pillarData')}")

    # School: teacher academic profile (atomic upsert -> idempotent)
    t = Gateway(a.gateway)
    st, _ = t.login(ACCOUNTS["teacher"], SYNTHETIC_PASSWORD)
    check("school: teacher login", st == 200, st)
    st, r = t.call("POST", "/api/school/profile", {"country": "BJ", "curriculumId": "cur_bj_bac", "levelId": "lvl_bj_tle_cd",
                                                    "primarySubjectId": "sub_bj_svt", "institutionName": "[SYNTHETIC] Lycée de démonstration",
                                                    "learningGoals": "[SYNTHETIC] Préparer les élèves de Terminale D en SVT"})
    check("school: teacher profile upsert", st in (200, 201), (st, r))

    # Business: second talent profile (upsert -> idempotent)
    b = Gateway(a.gateway)
    st, _ = b.login(ACCOUNTS["contributor2"], SYNTHETIC_PASSWORD)
    check("business: talent.adebayo login", st == 200, st)
    st, r = b.call("POST", "/api/business/actions", {"action": "upsert_talent_profile", "headline": "[SYNTHETIC] Spécialiste Yorùbá & NLP",
                                                     "country": "NG", "nativeLanguages": ["yo"], "otherLanguages": ["en", "fr"], "dialects": [],
                                                     "skills": ["annotation", "translation"], "availability": "AVAILABLE", "weeklyHours": 10,
                                                     "consentVoiceDataset": True})
    check("business: talent.adebayo profile upsert", st in (200, 201), (st, r))

    # Verification: every synthetic account can log in; pillar data is readable through the gateway.
    for role, em in ACCOUNTS.items():
        st, r = Gateway(a.gateway).login(em, SYNTHETIC_PASSWORD)
        check(f"verify: login {role} ({em})", st == 200, st)
    s = Gateway(a.gateway)
    s.login(ACCOUNTS["student"], SYNTHETIC_PASSWORD)
    st, r = s.call("POST", "/api/auth", {"action": "export_data"})
    prof = ((r.get("exportPackage") or {}).get("school") or {}).get("academicProfile") if st == 200 else None
    check("verify: student academic profile present (export_data)", bool(prof), (st, r))
    c = Gateway(a.gateway)
    c.login(ACCOUNTS["org_client"], SYNTHETIC_PASSWORD)
    st, r = c.call("GET", "/api/business/workspace")
    check("verify: org_client business workspace readable", st == 200, (st, str(r)[:200]))
    print(f"\n{'SEED OK' if not failures else 'SEED INCOMPLETE'}: {len(failures)} failure(s).")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
