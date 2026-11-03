"""Minimal stdlib HTTP client for the SOLOB+ gateway (session cookie + CSRF header). No third-party deps."""
import json
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class Gateway:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.cookies: dict[str, str] = {}
        self.csrf: str | None = None

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if method != "GET":
            req.add_header("Origin", "{0.scheme}://{0.netloc}".format(urlsplit(self.base)))
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        if self.csrf and method != "GET":
            req.add_header("X-Solob-CSRF", self.csrf)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, hdrs, raw = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, hdrs, raw = e.code, e.headers, e.read()
        for c in hdrs.get_all("Set-Cookie") or []:
            k, _, v = c.split(";", 1)[0].partition("=")
            if v:
                self.cookies[k.strip()] = v.strip()
            else:
                self.cookies.pop(k.strip(), None)
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            payload = {"raw": raw[:200].decode("utf-8", "replace")}
        if isinstance(payload, dict) and payload.get("csrfToken"):
            self.csrf = payload["csrfToken"]
        return status, payload

    def login(self, email: str, password: str) -> tuple[int, dict]:
        self.cookies.clear()
        self.csrf = None
        # The gateway rate-limits logins per client; a seed/smoke run logs in many times from one IP,
        # so honour 429 "retry after Ns" (bounded) instead of failing.
        for _ in range(3):
            st, r = self.call("POST", "/api/auth", {"action": "login", "email": email, "password": password})
            if st != 429:
                return st, r
            m = re.search(r"after (\d+)s", str(r))
            time.sleep(min(int(m.group(1)) if m else 30, 65) + 1)
        return st, r
