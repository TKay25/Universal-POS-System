"""Application configuration.

Every value can be overridden with an environment variable so the same image can
run in development, staging and production without code changes.
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    SECRET_KEY = os.environ.get("POS_SECRET_KEY", "dev-secret-change-me-in-production")
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "POS_DATABASE_URL", f"sqlite:///{(BASE_DIR / 'instance' / 'universal_pos.db').as_posix()}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

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


class TestConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SEED_DEMO_DATA = False
    DEVELOPER_PASSWORD = "TestDev!2024"
    WTF_CSRF_ENABLED = False
