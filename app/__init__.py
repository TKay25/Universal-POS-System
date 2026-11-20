"""Application factory."""

from __future__ import annotations

import os
import time
from pathlib import Path

import click
from flask import Flask, jsonify, render_template, request
from sqlalchemy.exc import OperationalError
from werkzeug.exceptions import HTTPException

from app.config import Config
from app.extensions import db
from app.utils import ValidationError


def create_app(config_object: type = Config, **overrides) -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config.from_object(config_object)
    app.config.update(overrides)
    # SQLite engines (tests, local demos) reject server-side pool arguments.
    if str(app.config.get("SQLALCHEMY_DATABASE_URI", "")).startswith("sqlite"):
        options = {
            key: value
            for key, value in (app.config.get("SQLALCHEMY_ENGINE_OPTIONS") or {}).items()
            if key not in {"pool_size", "max_overflow", "pool_recycle", "pool_timeout",
                           "pool_use_lifo", "connect_args"}
        }
        app.config["SQLALCHEMY_ENGINE_OPTIONS"] = options

    instance_path = Path(app.instance_path)
    instance_path.mkdir(parents=True, exist_ok=True)
    if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite:///"):
        raw = app.config["SQLALCHEMY_DATABASE_URI"].removeprefix("sqlite:///")
        Path(raw).parent.mkdir(parents=True, exist_ok=True)

    db.init_app(app)

    from app.blueprints.auth import bp as auth_bp
    from app.blueprints.activity import bp as activity_bp
    from app.blueprints.catalog import bp as catalog_bp
    from app.blueprints.company import bp as company_bp
    from app.blueprints.developer import bp as developer_bp
    from app.blueprints.laybys import bp as laybys_bp
    from app.blueprints.reports import bp as reports_bp
    from app.blueprints.report_delivery import bp as report_delivery_bp
    from app.blueprints.sales import bp as sales_bp
    from app.blueprints.workspaces import bp as workspaces_bp

    for blueprint in (
        auth_bp, activity_bp, company_bp, catalog_bp, sales_bp, laybys_bp, reports_bp, developer_bp,
        report_delivery_bp, workspaces_bp
    ):
        app.register_blueprint(blueprint)

    # ---- installable app --------------------------------------------------- #
    from app.pwa import init_pwa

    init_pwa(app)

    # ---- cross cutting ---------------------------------------------------- #
    from app.security import (
        ApiError, PASSWORD_CHANGE_ALLOWED_PATHS, csrf_protect, password_change_required,
    )

    @app.before_request
    def _guard():
        if request.path.startswith("/api/"):
            # All branches is an aggregate, read-only context. Operational
            # writes must belong to one shop; settings stay editable so a
            # manager can create the branch they want to switch to.
            if (
                request.method in {"POST", "PUT", "PATCH", "DELETE"}
                and request.headers.get("X-Branch-Scope") == "all"
                and request.path not in {"/api/sales/lookup-receipt", "/api/discounts/validate"}
                and request.path.startswith((
                    "/api/sales", "/api/shifts", "/api/holds", "/api/laybys", "/api/products",
                    "/api/categories", "/api/departments", "/api/customers", "/api/inventory",
                ))
            ):
                return (
                    jsonify(
                        {
                            "error": {
                                "message": "All branches is read-only. Switch to a branch to make changes.",
                                "code": "branch_required",
                                "fields": {},
                            }
                        }
                    ),
                    409,
                )
            try:
                csrf_protect()
            except ApiError as error:
                return error.to_response()
            # A temporary password unlocks nothing until the teammate replaces it.
            if request.path not in PASSWORD_CHANGE_ALLOWED_PATHS and password_change_required():
                return (
                    jsonify(
                        {
                            "error": {
                                "message": "Choose your own password to keep using this account.",
                                "code": "password_change_required",
                                "fields": {},
                            }
                        }
                    ),
                    403,
                )

    @app.errorhandler(ApiError)
    def _api_error(error: ApiError):
        return error.to_response()

    @app.errorhandler(ValidationError)
    def _validation_error(error: ValidationError):
        return (
            jsonify(
                {
                    "error": {
                        "message": "Please review the highlighted fields.",
                        "code": "validation_error",
                        "fields": error.fields,
                    }
                }
            ),
            422,
        )

    @app.errorhandler(HTTPException)
    def _http_error(error: HTTPException):
        if request.path.startswith("/api/"):
            return (
                jsonify(
                    {
                        "error": {
                            "message": error.description or error.name,
                            "code": (error.name or "error").lower().replace(" ", "_"),
                            "fields": {},
                        }
                    }
                ),
                error.code or 500,
            )
        if error.code == 404:
            return render_template("index.html"), 200
        return error

    @app.errorhandler(Exception)
    def _unexpected(error: Exception):
        app.logger.exception("Unhandled error on %s", request.path)
        db.session.rollback()
        if request.path.startswith("/api/"):
            return (
                jsonify(
                    {
                        "error": {
                            "message": "Something went wrong on our side. Please try again.",
                            "code": "server_error",
                            "fields": {},
                        }
                    }
                ),
                500,
            )
        raise error

    @app.after_request
    def _headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        if response.mimetype == "text/html":
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob:; "
                "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
                "connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'",
            )
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and request.path.startswith("/api/")
            and response.status_code < 400
        ):
            # Reports, PDFs and the till bundle are TTL cached; a successful
            # write must not leave a stale dashboard or product list behind.
            from app.services import cache

            cache.clear()
        return response

    # ---- SPA shell -------------------------------------------------------- #
    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        from app import dbhelper

        payload = {"status": "ok", "service": "universal-pos", "pool": dbhelper.pool_status()}
        # ``?db=1`` also talks to the database (Render's probe stays cheap by default).
        if request.args.get("db"):
            reachable = dbhelper.ping()
            payload["database"] = "ok" if reachable else "unavailable"
            if not reachable:
                payload["status"] = "degraded"
                return jsonify(payload), 503
        return jsonify(payload)

    # ---- CLI -------------------------------------------------------------- #
    @app.cli.command("init-db")
    def init_db_command():  # pragma: no cover - CLI helper
        db.create_all()
        print("Tables created.")

    @app.cli.command("seed")
    def seed_command():  # pragma: no cover - CLI helper
        from app.seed import seed_all

        db.create_all()
        created = seed_all(app)
        print(created)

    @app.cli.command("send-executive-reports")
    @click.option("--force", is_flag=True, help="Send even if today's report already went out.")
    @click.option("--dry-run", is_flag=True, help="Build and print without sending.")
    def send_executive_reports_command(force: bool, dry_run: bool):  # pragma: no cover - CLI helper
        """Send the 6pm executive summary to every due company (idempotent)."""
        from app.services.daily_reports import dispatch_due

        results = dispatch_due(force=force, dry_run=dry_run)
        for result in results:
            print(f"{result.get('company')}: {result.get('status')} ({result.get('reason', 'ok')})")
            if dry_run and result.get("text"):
                print(result["text"])
                print("-" * 60)
        if not results:
            print("No company is due for a report right now.")

    def _bootstrap():
        """Create the schema (and demo data) tolerating a slow/transient database."""
        last_error = None
        for attempt in range(4):
            try:
                db.create_all()
                from app.schema import ensure_columns

                ensure_columns()
                if app.config.get("SEED_DEMO_DATA") and not app.config.get("TESTING"):
                    from app.seed import seed_all

                    seed_all(app)
                if not app.config.get("TESTING"):
                    # Give categories created before icons existed a sensible tile.
                    from app.schema import backfill_category_icons

                    backfill_category_icons()
                    # Give pre-existing stock its first FIFO cost layer.
                    from app.models import Company
                    from app.services import fifo

                    for company in Company.query.all():
                        try:
                            fifo.backfill_company(company.id)
                        except Exception as error:  # pragma: no cover - data issues
                            app.logger.warning("FIFO backfill failed for company %s: %s", company.id, error)
                            db.session.rollback()
                return
            except OperationalError as error:  # pragma: no cover - network/db startup
                last_error = error
                app.logger.warning("Database not ready (attempt %s/4): %s", attempt + 1, error)
                db.session.rollback()
                time.sleep(2 * (attempt + 1))
        raise last_error

    with app.app_context():
        _bootstrap()
        if not app.config.get("TESTING"):  # pragma: no cover - pool warm-up
            from app import dbhelper

            # The first requests of a cold worker would otherwise pay the TLS
            # handshake and Postgres authentication each.
            dbhelper.warm_pool(2)

    if app.config.get("DAILY_REPORT_SCHEDULER") and not app.config.get("TESTING"):
        from app.services.daily_reports import start_scheduler

        start_scheduler(app)

    return app
