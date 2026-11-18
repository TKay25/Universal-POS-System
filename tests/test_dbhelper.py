"""Database helpers: raw SQL reads, bulk writes, transactions, retries and pool state."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import OperationalError

from app import dbhelper
from app.extensions import db
from app.models import Company


def _probe_table():
    return db.Table(
        "dbhelper_probe",
        db.metadata,
        db.Column("id", db.Integer, primary_key=True),
        db.Column("label", db.String(20), nullable=False),
    )


def test_fetch_helpers_return_plain_rows(app):
    assert dbhelper.fetch_value("SELECT 1") == 1
    assert dbhelper.fetch_value("SELECT :n * 2", {"n": 21}) == 42

    row = dbhelper.fetch_one("SELECT :name AS name", {"name": "Nova"})
    assert row == {"name": "Nova"}
    assert dbhelper.fetch_one("SELECT 1 AS one WHERE 1 = 0") is None

    assert dbhelper.fetch_all("SELECT 1 AS n UNION ALL SELECT 2") == [{"n": 1}, {"n": 2}]


def test_same_statement_is_compiled_once(app):
    dbhelper._clause.cache_clear()
    before = dbhelper._clause.cache_info()
    for _ in range(3):
        dbhelper.fetch_value("SELECT :n", {"n": 7})
    after = dbhelper._clause.cache_info()
    assert after.misses == before.misses + 1
    assert after.hits == before.hits + 2


def test_insert_rows_writes_with_executemany(app):
    table = _probe_table()
    table.create(dbhelper.engine(), checkfirst=True)

    written = dbhelper.insert_rows(table, [{"label": f"row-{i}"} for i in range(1200)])

    assert written == 1200
    assert dbhelper.fetch_value("SELECT COUNT(*) FROM dbhelper_probe") == 1200
    assert dbhelper.exists(Company, slug="nobody") is False


def test_session_scope_commits_and_rolls_back(app):
    with dbhelper.session_scope() as session:
        session.add(Company(name="Scoped Co", slug="scoped-co"))
    assert dbhelper.fetch_value("SELECT COUNT(*) FROM companies") == 1

    with pytest.raises(RuntimeError):
        with dbhelper.session_scope() as session:
            session.add(Company(name="Gone Co", slug="gone-co"))
            raise RuntimeError("boom")

    assert dbhelper.fetch_value("SELECT COUNT(*) FROM companies") == 1


def test_retry_transient_recovers_from_a_dropped_connection(app):
    calls = {"n": 0}

    @dbhelper.retry_transient(attempts=3, delay=0)
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise OperationalError("SELECT 1", {}, Exception("server closed the connection unexpectedly"))
        return "ok"

    assert flaky() == "ok"
    assert calls["n"] == 3


def test_retry_transient_gives_up_after_the_last_attempt(app):
    calls = {"n": 0}

    @dbhelper.retry_transient(attempts=2, delay=0)
    def always_down():
        calls["n"] += 1
        raise OperationalError("SELECT 1", {}, Exception("could not connect to server"))

    with pytest.raises(OperationalError):
        always_down()
    assert calls["n"] == 2


def test_pool_helpers_report_state(app):
    assert dbhelper.ping() is True
    assert dbhelper.warm_pool(2) == 2

    status = dbhelper.pool_status()
    assert status["class"]
    assert {"checked_in", "checked_out", "overflow"} <= set(status)
