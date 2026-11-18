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


def test_engine_options_keep_remote_connections_warm(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv(
        "POS_DATABASE_URL",
        "postgresql://user:pass@dpg-abc.oregon-postgres.render.com:5432/dbname",
    )
    options = config._engine_options(config._database_url())

    assert options["pool_use_lifo"] is True  # reuses the hottest connection first
    assert options["pool_timeout"] == 30
    assert options["connect_args"] == {"connect_timeout": 10, "application_name": "universal-pos"}


def test_sqlite_engines_drop_server_side_pool_options():
    from app import create_app

    class SqliteConfig(config.TestConfig):
        SQLALCHEMY_DATABASE_URI = "sqlite://"
        SQLALCHEMY_ENGINE_OPTIONS = {
            "pool_recycle": 280,
            "pool_size": 5,
            "max_overflow": 10,
            "pool_timeout": 30,
            "pool_use_lifo": True,
            "connect_args": {"connect_timeout": 10, "application_name": "universal-pos"},
        }

    application = create_app(SqliteConfig)
    options = application.config["SQLALCHEMY_ENGINE_OPTIONS"]
    assert {"pool_size", "max_overflow", "pool_timeout", "pool_use_lifo", "connect_args"}.isdisjoint(options)
