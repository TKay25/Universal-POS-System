"""Database helpers.

Flask-SQLAlchemy owns the engine and the scoped session; this module holds the
pieces that keep a remote Postgres fast and predictable:

* :func:`fetch_all` / :func:`fetch_one` / :func:`fetch_value` run raw SQL through a
  single cached ``text()`` clause per statement, so the driver reuses one prepared
  statement per shape instead of re-planning every call.
* :func:`insert_rows` writes with ``executemany`` instead of the ORM unit of work.
* :func:`warm_pool` / :func:`pool_status` make cold starts and pool pressure visible.
* :func:`retry_transient` retries a dropped connection once instead of returning a 500.

Everything works inside an app context and therefore shares the request session.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from functools import lru_cache, wraps
from typing import Any, Callable, Generator, Mapping, Sequence

from sqlalchemy import Table, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

from app.extensions import db

# Messages psycopg2 raises when the server or the socket went away mid-flight.
TRANSIENT_MESSAGES = (
    "server closed the connection unexpectedly",
    "connection already closed",
    "terminating connection",
    "ssl syscall",
    "connection reset by peer",
    "broken pipe",
    "could not connect to server",
)


def engine() -> Engine:
    """The configured engine for the current app (pooled, one per process)."""
    return db.engine


@lru_cache(maxsize=256)
def _clause(sql: str):
    """Compile each SQL string once; the driver then reuses its prepared statement."""
    return text(sql)


def execute(sql: str, params: Mapping[str, Any] | None = None):
    return db.session.execute(_clause(sql), dict(params or {}))


def fetch_all(sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a read query and return plain dictionaries (cheap, no ORM identity map)."""
    return [dict(row) for row in execute(sql, params).mappings()]


def fetch_one(sql: str, params: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    row = execute(sql, params).mappings().first()
    return dict(row) if row is not None else None


def fetch_value(sql: str, params: Mapping[str, Any] | None = None) -> Any:
    """First column of the first row - counters, sums, ``SELECT 1``."""
    return execute(sql, params).scalar()


def insert_rows(
    target: Table | type,
    rows: Sequence[Mapping[str, Any]],
    *,
    chunk_size: int = 500,
) -> int:
    """Insert many rows with ``executemany`` (one round trip per chunk)."""
    table = target if isinstance(target, Table) else target.__table__
    total = 0
    for start in range(0, len(rows), max(1, chunk_size)):
        chunk = [dict(row) for row in rows[start:start + chunk_size]]
        if chunk:
            db.session.execute(table.insert(), chunk)
            total += len(chunk)
    return total


def exists(model: type, **filters: Any) -> bool:
    """Cheap ``EXISTS`` probe that never loads the full row."""
    return db.session.execute(select(model).filter_by(**filters).limit(1)).first() is not None


@contextmanager
def session_scope() -> Generator[Any, None, None]:
    """Commit on success and roll back on failure (for work outside a request)."""
    session = db.session
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise


def retry_transient(attempts: int = 3, delay: float = 0.15) -> Callable:
    """Retry a callable when the database connection dropped (idle socket, deploy)."""

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            for attempt in range(1, attempts + 1):
                try:
                    return func(*args, **kwargs)
                except OperationalError:
                    if attempt == attempts:
                        raise
                    db.session.rollback()
                    time.sleep(delay * attempt)
            raise AssertionError("unreachable")

        return wrapper

    return decorator


def warm_pool(connections: int = 1) -> int:
    """Open connections up front so the first request skips TLS handshake and auth."""
    warmed = 0
    for _ in range(max(1, connections)):
        connection = engine().connect()
        connection.close()  # returns to the pool, still open
        warmed += 1
    return warmed


def ping() -> bool:
    """True when the database answers ``SELECT 1``."""
    try:
        fetch_value("SELECT 1")
        return True
    except OperationalError:
        return False


def pool_status() -> dict[str, Any]:
    """Pool counters for health checks and support tickets (never touches the network)."""
    pool = engine().pool

    def count(name: str) -> int | None:
        method = getattr(pool, name, None)
        if method is None:
            return None
        try:
            return int(method())
        except Exception:  # pragma: no cover - pool implementations without counters
            return None

    return {
        "class": type(pool).__name__,
        "status": pool.status() if hasattr(pool, "status") else "",
        "checked_in": count("checkedin"),
        "checked_out": count("checkedout"),
        "overflow": count("overflow"),
    }
