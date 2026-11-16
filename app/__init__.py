"""Application factory."""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from app.config import Config
from app.extensions import db
from app.utils import ValidationError


def create_app(config_object: type = Config, **overrides) -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config.from_object(config_object)
    app.config.update(overrides)

    instance_path = Path(app.instance_path)
    instance_path.mkdir(parents=True, exist_ok=True)
    if app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite:///"):
        raw = app.config["SQLALCHEMY_DATABASE_URI"].removeprefix("sqlite:///")
        Path(raw).parent.mkdir(parents=True, exist_ok=True)

    db.init_app(app)

    from app.blueprints.auth import bp as auth_bp
    from app.blueprints.catalog import bp as catalog_bp
    from app.blueprints.company import bp as company_bp
    from app.blueprints.developer import bp as developer_bp
    from app.blueprints.laybys import bp as laybys_bp
    from app.blueprints.reports import bp as reports_bp
    from app.blueprints.sales import bp as sales_bp
    from app.blueprints.workspaces import bp as workspaces_bp

    for blueprint in (
        auth_bp, company_bp, catalog_bp, sales_bp, laybys_bp, reports_bp, developer_bp, workspaces_bp
    ):
        app.register_blueprint(blueprint)

    # ---- cross cutting ---------------------------------------------------- #
    from app.security import ApiError, csrf_protect

    @app.before_request
    def _guard():
        if request.path.startswith("/api/"):
            try:
                csrf_protect()
            except ApiError as error:
                return error.to_response()

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
        return response

    # ---- SPA shell -------------------------------------------------------- #
    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/healthz")
    def healthz():
        return jsonify({"status": "ok", "service": "universal-pos"})

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

    with app.app_context():
        db.create_all()
        if app.config.get("SEED_DEMO_DATA") and not app.config.get("TESTING"):
            from app.seed import seed_all

            seed_all(app)

    return app
