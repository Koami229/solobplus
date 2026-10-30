"""Shared psycopg connection pools (one per URL and autocommit mode), opened lazily.
`connection()` keeps psycopg's transaction semantics: commit on success, rollback on exception,
then the connection goes back to the pool instead of being closed."""
from __future__ import annotations
import os, threading
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout
from .errors import AppError

_pools: dict[tuple[str, bool], ConnectionPool] = {}
_lock = threading.Lock()

def pool(url: str, autocommit: bool = False) -> ConnectionPool:
    key = (url, autocommit)
    with _lock:
        p = _pools.get(key)
        if p is None:
            p = ConnectionPool(url, min_size=int(os.environ.get("DB_POOL_MIN", "1")), max_size=int(os.environ.get("DB_POOL_MAX", "10")),
                               kwargs={"row_factory": dict_row, "autocommit": autocommit}, timeout=5.0, open=True,
                               check=ConnectionPool.check_connection, name=f"school-{'ac' if autocommit else 'tx'}")
            _pools[key] = p
        return p

class _Conn:
    def __init__(self, url, autocommit): self._cm = pool(url, autocommit).connection()
    def __enter__(self):
        try: return self._cm.__enter__()
        except PoolTimeout: raise AppError(503, "DATABASE_UNAVAILABLE", "Database pool exhausted or unreachable.")
    def __exit__(self, *exc): return self._cm.__exit__(*exc)

def connection(url: str, autocommit: bool = False) -> _Conn:
    if not url: raise AppError(503, "DATABASE_UNAVAILABLE", "School database is not configured.")
    return _Conn(url, autocommit)

def close_all() -> None:
    with _lock:
        for p in _pools.values(): p.close()
        _pools.clear()
