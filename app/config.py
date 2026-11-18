"""Application configuration.

Every value can be overridden with an environment variable so the same image can
run in development, staging and production without code changes.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE pairs from a local .env file (never committed)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


_load_dotenv(BASE_DIR / ".env")


def _database_url() -> str:
    """Resolve the SQLAlchemy URL, preferring an explicit Postgres connection."""
    raw = (os.environ.get("POS_DATABASE_URL") or os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        return f"sqlite:///{(BASE_DIR / 'instance' / 'universal_pos.db').as_posix()}"
    if raw.startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://"):]
    if raw.startswith("postgresql"):
        # Always drive Postgres through psycopg2, which requirements.txt ships.
        # Newer SQLAlchemy releases pick psycopg 3 for a bare ``postgresql://``
        # URL, which is not installed and crashes the worker at boot.
        rest = raw[len("postgresql"):]
        if rest.startswith("+"):
            rest = rest[rest.index("://"):]
        raw = "postgresql+psycopg2" + rest
        host = raw.split("@")[-1]
        is_local = host.startswith(("localhost", "127.0.0.1", "::1"))
        if not is_local and "sslmode=" not in raw:
            raw += ("&" if "?" in raw else "?") + "sslmode=require"
    return raw


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _engine_options(url: str) -> dict:
    """Pool tuning. Remote URLs get a longer recycle so idle sockets are dropped."""
    options = {"pool_recycle": 280}
    # Each checkout pings the database; on a high-latency link that is a full
    # round trip per request. Keep it on by default, allow it to be turned off.
    options["pool_pre_ping"] = _env_bool("POS_DB_PRE_PING", True)
    if not url.startswith("sqlite"):
        options["pool_size"] = int(os.environ.get("POS_DB_POOL_SIZE", "5"))
        options["max_overflow"] = int(os.environ.get("POS_DB_MAX_OVERFLOW", "10"))
        # LIFO keeps the busiest connections warm instead of rotating the whole
        # pool, so TLS/back-end setup is paid once rather than every N requests.
        options["pool_use_lifo"] = _env_bool("POS_DB_POOL_USE_LIFO", True)
        options["pool_timeout"] = int(os.environ.get("POS_DB_POOL_TIMEOUT", "30"))
        options["connect_args"] = {
            # Fail fast instead of hanging a worker on an unreachable database.
            "connect_timeout": int(os.environ.get("POS_DB_CONNECT_TIMEOUT", "10")),
            # Shows up in pg_stat_activity, which makes slow queries easy to trace.
            "application_name": os.environ.get("POS_DB_APP_NAME", "universal-pos"),
        }
    return options


class Config:
    SECRET_KEY = os.environ.get("POS_SECRET_KEY", "dev-secret-change-me-in-production")
    SQLALCHEMY_DATABASE_URI = _database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = _engine_options(SQLALCHEMY_DATABASE_URI)

    JSON_SORT_KEYS = False
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _env_bool("POS_COOKIE_SECURE", False)
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 12

    # Auth hardening
    LOGIN_MAX_ATTEMPTS = int(os.environ.get("POS_LOGIN_MAX_ATTEMPTS", "8"))
    LOGIN_LOCKOUT_SECONDS = int(os.environ.get("POS_LOGIN_LOCKOUT_SECONDS", "300"))

    # Developer bootstrap account
    DEVELOPER_EMAIL = os.environ.get("POS_DEVELOPER_EMAIL", "developer@universalpos.dev")
    DEVELOPER_PASSWORD = os.environ.get("POS_DEVELOPER_PASSWORD", "DevAdmin!2024")

    SEED_DEMO_DATA = _env_bool("POS_SEED_DEMO", True)

    RECEIPT_FOOTER_LIMIT = 240
    MAX_CUSTOM_MODULES = 40

    # Reports and PDFs are cached briefly so repeat downloads are instant.
    # Set to 0 to disable caching (handy while developing).
    REPORT_CACHE_SECONDS = int(os.environ.get("POS_REPORT_CACHE_SECONDS", "60"))


class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SQLALCHEMY_ENGINE_OPTIONS = {}
    SEED_DEMO_DATA = False
    DEVELOPER_PASSWORD = "TestDev!2024"
    WTF_CSRF_ENABLED = False
    REPORT_CACHE_SECONDS = 0
