"""Session authentication, CSRF protection, tenancy resolution and audit."""

from __future__ import annotations

import secrets
from functools import wraps

from flask import current_app, g, jsonify, request, session

from app.extensions import db
from app.models import AuditLog, Company, User
from app.utils import utcnow

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/register", "/api/auth/status"}


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "bad_request", fields: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.fields = fields or {}

    def to_response(self):
        return jsonify({"error": {"message": self.message, "code": self.code, "fields": self.fields}}), self.status


def unauthorized(message: str = "Please sign in to continue."):
    raise ApiError(message, 401, "unauthorized")


def forbidden(message: str = "You do not have access to that."):
    raise ApiError(message, 403, "forbidden")


def not_found(message: str = "Not found."):
    raise ApiError(message, 404, "not_found")


def bad_request(message: str, fields: dict | None = None):
    raise ApiError(message, 422, "validation_error", fields)


# --------------------------------------------------------------------------- #
# CSRF
# --------------------------------------------------------------------------- #
def csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def csrf_protect() -> None:
    if request.method in SAFE_METHODS:
        return
    if request.path in CSRF_EXEMPT_PATHS:
        return
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token") or (request.get_json(silent=True) or {}).get("_csrf")
    if not expected or not supplied or not secrets.compare_digest(str(expected), str(supplied)):
        raise ApiError("Your session token expired. Refresh the page and try again.", 419, "csrf_failed")


# --------------------------------------------------------------------------- #
# Current session objects
# --------------------------------------------------------------------------- #
def current_user() -> User | None:
    if "current_user" in g:
        return g.current_user
    user = None
    user_id = session.get("user_id")
    if user_id:
        user = db.session.get(User, user_id)
        if user and user.status != "active":
            user = None
    g.current_user = user
    return user


def current_company() -> Company | None:
    """The company workspace the request acts on.

    Developers act on a company only after explicitly entering it, which keeps
    the platform console and a tenant workspace strictly separated.
    """
    if "current_company" in g:
        return g.current_company

    user = current_user()
    company = None
    if user is not None:
        company_id = session.get("impersonate_company_id")
        if user.is_developer and company_id:
            company = db.session.get(Company, company_id)
        elif user.company_id:
            company = user.company
    g.current_company = company
    return company


def acting_user() -> User:
    """The effective user for audit trails.

    A developer inside a company workspace is recorded as the platform
    developer, never as the impersonated person.
    """
    user = current_user()
    if user is None:
        unauthorized()
    return user


# --------------------------------------------------------------------------- #
# Guards
# --------------------------------------------------------------------------- #
def _login_redirect():
    return ApiError("Please sign in to continue.", 401, "unauthorized")


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return _login_redirect().to_response()
        return view(*args, **kwargs)

    return wrapper


def developer_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return _login_redirect().to_response()
        if not user.is_developer:
            return forbidden("The developer console is restricted to platform staff.").to_response()
        return view(*args, **kwargs)

    return wrapper


def company_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return _login_redirect().to_response()
        company = current_company()
        if company is None:
            return ApiError(
                "Open a company workspace to continue." if user.is_developer
                else "Your account is not linked to a company.",
                409,
                "no_company",
            ).to_response()
        if company.status == "suspended" and not user.is_developer:
            return ApiError(
                "This workspace is suspended. Contact support for help.",
                423,
                "company_suspended",
            ).to_response()
        g.company = company
        return view(*args, **kwargs)

    return wrapper


def permission_required(*permissions: str):
    """Require at least one of the supplied permissions."""

    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            user = current_user()
            if user is None:
                return _login_redirect().to_response()
            if not user.has_any(*permissions):
                return forbidden(
                    f"This action needs the '{permissions[0]}' permission."
                ).to_response()
            return view(*args, **kwargs)

        return wrapper

    return decorator


def module_required(key: str):
    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            company = current_company()
            if company is None:
                return ApiError("No company workspace selected.", 409, "no_company").to_response()
            if not company.module_enabled(key):
                return ApiError(
                    f"The '{key}' module is not enabled for this company.",
                    409,
                    "module_disabled",
                ).to_response()
            return view(*args, **kwargs)

        return wrapper

    return decorator


def company_id() -> int:
    company = current_company()
    if company is None:
        raise ApiError("No company workspace selected.", 409, "no_company")
    return company.id


# --------------------------------------------------------------------------- #
# Sessions
# --------------------------------------------------------------------------- #
def start_session(user: User, *, impersonate_company_id: int | None = None) -> None:
    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    if impersonate_company_id:
        session["impersonate_company_id"] = impersonate_company_id
    csrf_token()
    g.pop("current_user", None)
    g.pop("current_company", None)


def end_session() -> None:
    session.clear()
    g.pop("current_user", None)
    g.pop("current_company", None)


def enter_company(company_id: int) -> None:
    session["impersonate_company_id"] = company_id
    g.pop("current_company", None)


def leave_company() -> None:
    session.pop("impersonate_company_id", None)
    g.pop("current_company", None)


# --------------------------------------------------------------------------- #
# Login throttling
# --------------------------------------------------------------------------- #
def is_locked(user: User) -> bool:
    return bool(user.locked_until and user.locked_until > utcnow())


def register_failed_login(user: User) -> None:
    limit = current_app.config["LOGIN_MAX_ATTEMPTS"]
    window = current_app.config["LOGIN_LOCKOUT_SECONDS"]
    user.failed_logins = (user.failed_logins or 0) + 1
    if user.failed_logins >= limit:
        from datetime import timedelta

        user.locked_until = utcnow() + timedelta(seconds=window)
        user.failed_logins = 0
    db.session.commit()


def register_successful_login(user: User) -> None:
    user.failed_logins = 0
    user.locked_until = None
    user.last_login_at = utcnow()
    db.session.commit()


# --------------------------------------------------------------------------- #
# Audit trail
# --------------------------------------------------------------------------- #
def audit(action: str, *, entity: str = "", entity_id="", summary: str = "", meta: dict | None = None,
          company_id: int | None = None, commit: bool = False) -> AuditLog:
    user = current_user()
    entry = AuditLog(
        company_id=company_id if company_id is not None else (current_company().id if current_company() else None),
        user_id=user.id if user else None,
        actor_email=user.email if user else "system",
        actor_name=user.full_name if user else "System",
        action=action,
        entity=entity,
        entity_id=str(entity_id or ""),
        summary=summary[:240],
        meta=meta or {},
        ip=(request.headers.get("X-Forwarded-For", request.remote_addr or "") or "").split(",")[0].strip()[:60],
    )
    db.session.add(entry)
    if commit:
        db.session.commit()
    return entry
