"""Configuration helpers: database URL normalisation."""

from __future__ import annotations

from app import config


def test_database_url_forces_the_shipped_psycopg2_driver(monkeypatch):
    """A bare (or psycopg3) URL must resolve to psycopg2, which we install."""
    monkeypatch.delenv("DATABASE_URL", raising=False)

    monkeypatch.setenv(
        "POS_DATABASE_URL",
        "postgresql://user:pass@dpg-abc.oregon-postgres.render.com:5432/dbname",
    )
    url = config._database_url()
    assert url.startswith("postgresql+psycopg2://user:pass@dpg-abc.oregon-postgres.render.com:5432/dbname")
    assert url.endswith("?sslmode=require")

    monkeypatch.setenv("POS_DATABASE_URL", "postgresql+psycopg://user:pass@host:5432/db")
    assert config._database_url() == "postgresql+psycopg2://user:pass@host:5432/db?sslmode=require"

    # Local connections do not get the SSL flag grafted on.
    monkeypatch.setenv("POS_DATABASE_URL", "postgres://user:pass@localhost:5432/db")
    assert config._database_url() == "postgresql+psycopg2://user:pass@localhost:5432/db"


def test_database_url_falls_back_to_sqlite(monkeypatch):
    monkeypatch.delenv("POS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert config._database_url().startswith("sqlite:///")
