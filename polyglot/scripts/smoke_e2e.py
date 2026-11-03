#!/usr/bin/env python3
"""End-to-end smoke test through the gateway (stdlib only). Exits non-zero on the first broken step.

Checks: /api/health (gateway + DB), unauthenticated access is refused, admin login -> session cookie +
CSRF token, /api/auth returns the user, admin overview, School catalog and Business workspace via the
gateway reverse proxy (proves service-to-service auth), CSRF is enforced, logout revokes the session.
Env: SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD; --gateway (default http://127.0.0.1:8100).
"""
import argparse
import os
import sys

from solob_client import Gateway


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gateway", default=os.environ.get("GATEWAY_URL", "http://127.0.0.1:8100"))
    a = ap.parse_args()
    email, pwd = os.environ.get("SMOKE_ADMIN_EMAIL"), os.environ.get("SMOKE_ADMIN_PASSWORD")
    if not email or not pwd:
        print("SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD are required.", file=sys.stderr)
        return 2
    g = Gateway(a.gateway)
    steps = []

    def step(label, cond, detail=""):
        steps.append(label)
        print(("OK   " if cond else "FAIL ") + label + ("" if cond else f" -> {detail}"))
        if not cond:
            sys.exit(1)

    st, r = g.call("GET", "/api/health")
    step("health: gateway + database up", st == 200 and r.get("database") == "up", (st, r))
    st, r = g.call("GET", "/api/admin/overview")
    step("anonymous admin overview refused (401/403)", st in (401, 403), (st, r))
    st, r = g.call("POST", "/api/auth", {"action": "login", "email": email, "password": "wrong-password-123"})
    step("wrong password refused", st in (400, 401), (st, r))
    st, r = g.login(email, pwd)
    step("admin login -> session cookie + CSRF token", st == 200 and "solob_session" in g.cookies and bool(g.csrf), (st, r))
    st, r = g.call("GET", "/api/auth")
    step("GET /api/auth returns the admin", st == 200 and (r.get("user") or {}).get("role") == "admin", (st, r))
    st, r = g.call("GET", "/api/admin/overview")
    step("admin overview", st == 200, (st, r))
    st, r = g.call("GET", "/api/school/catalog")
    step("School (Python) catalog via gateway proxy", st == 200 and r.get("curricula"), (st, str(r)[:200]))
    st, r = g.call("GET", "/api/business/workspace")
    step("Business (Java) workspace via gateway proxy", st == 200, (st, str(r)[:200]))
    saved, g.csrf = g.csrf, None
    st, r = g.call("POST", "/api/auth", {"action": "export_data"})
    step("cookie-authenticated POST without CSRF header refused (403)", st == 403, (st, r))
    g.csrf = saved
    st, r = g.call("POST", "/api/auth", {"action": "logout"})
    step("logout", st == 200, (st, r))
    st, r = g.call("GET", "/api/admin/overview")
    step("session revoked after logout", st in (401, 403), (st, r))
    print(f"\nSMOKE OK: {len(steps)} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
