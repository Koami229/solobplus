import os
os.environ.setdefault("APP_ENV", "test")

import pytest as _pytest
@_pytest.fixture(scope="session", autouse=True)
def _close_pools():
    yield
    from solob_school import db
    db.close_all()
