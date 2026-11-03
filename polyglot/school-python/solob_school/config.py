"""Startup configuration checks shared with the Rust gateway and the Java service.

SERVICE_SECRET rule (identical in the 3 services):
- a provided value must be >= 32 characters and not a placeholder, in every environment;
- if it is missing, only APP_ENV=development|test falls back to a shared, clearly-labelled dev-only value;
- anywhere else (production, staging, or APP_ENV unset) the process refuses to start.
"""
import os
from typing import Optional

DEV_ONLY_SERVICE_SECRET = "solob-local-dev-only-service-secret-2026"
DEV_ENVS = {"development", "test"}


def is_placeholder(s: str) -> bool:
    low = s.strip().lower()
    return "changeme" in low or "replace_with" in low or low in {"secret", "ephemeral-hmac-key"}


def resolve_service_secret(raw: Optional[str], app_env: Optional[str]) -> str:
    s = (raw or "").strip()
    dev = (app_env or "").strip().lower() in DEV_ENVS
    if s:
        if len(s) < 32 or is_placeholder(s):
            raise RuntimeError("FATAL: SERVICE_SECRET must be a non-placeholder value of at least 32 characters.")
        return s
    if dev:
        return DEV_ONLY_SERVICE_SECRET
    raise RuntimeError("FATAL: SERVICE_SECRET (>= 32 chars) is required outside APP_ENV=development|test.")


def service_secret_from_env() -> str:
    return resolve_service_secret(os.environ.get("SERVICE_SECRET"), os.environ.get("APP_ENV"))
