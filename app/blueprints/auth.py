"""Authentication, self-service signup and the session bootstrap payload."""

from __future__ import annotations

from flask import Blueprint, jsonify, request, session

from app.defaults import DASHBOARD_WIDGETS, PERMISSIONS
from app.extensions import db
from app.models import Announcement, Company, User
from app.modules import public_catalog
from app.security import (
    ApiError,
    audit,
    bad_request,
    csrf_token,
    current_company,
    current_user,
    developer_required,
    end_session,
    enter_company,
    is_locked,
    leave_company,
    login_required,
    register_failed_login,
    register_successful_login,
    start_session,
)
from app.services.checkout import current_shift
from app.utils import iso, utcnow, validate

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def active_announcements(company: Company | None) -> list[dict]:
    now = utcnow()
    rows = Announcement.query.filter_by(is_active=True).order_by(Announcement.created_at.desc()).limit(6).all()
    payload = []
    for row in rows:
        if row.expires_at and row.expires_at < now:
            continue
        if row.audience == "selected" and (company is None or company.id not in (row.company_ids or [])):
            continue
        payload.append(row.to_dict())
    return payload


def build_session_payload(user: User) -> dict:
    company = current_company()
    payload = {
        "authenticated": True,
        "csrf_token": csrf_token(),
        "user": user.to_dict(),
        "is_developer": user.is_developer,
        "company": company.to_dict(detail=True) if company else None,
        "modules": company.module_state if company else {},
        "module_catalog": public_catalog(),
        "permissions_catalog": PERMISSIONS,
        "dashboard_widgets": DASHBOARD_WIDGETS,
        "announcements": active_announcements(company),
        "shift": None,
        "impersonating": bool(user.is_developer and session.get("impersonate_company_id")),
        "companies": [c.to_dict() for c in Company.query.order_by(Company.name).all()] if user.is_developer else [],
        "server_time": iso(utcnow()),
    }
    if company is not None:
        shift = current_shift(company, user)
        payload["shift"] = shift.to_dict() if shift else None
    return payload


@bp.get("/session")
def read_session():
    user = current_user()
    if user is None:
        return jsonify(
            {
                "authenticated": False,
                "csrf_token": csrf_token(),
                "permissions_catalog": PERMISSIONS,
                "dashboard_widgets": DASHBOARD_WIDGETS,
            }
        )
    return jsonify(build_session_payload(user))


@bp.post("/login")
def login():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "email": {"type": "email", "required": True, "max_len": 180, "label": "Email"},
            "password": {"type": "text", "required": True, "max_len": 200, "trim": False, "label": "Password"},
        },
    )
    email = payload["email"].lower()
    user = User.query.filter(db.func.lower(User.email) == email).first()
    if user is None or not user.check_password(payload["password"]):
        if user is not None:
            register_failed_login(user)
        raise ApiError("That email and password combination is not right.", 401, "invalid_credentials")

    if is_locked(user):
        raise ApiError(
            "Too many attempts. Try again in a few minutes.", 429, "locked_out"
        )
    if user.status == "disabled":
        raise ApiError("This account has been disabled. Contact your administrator.", 403, "account_disabled")
    if not user.is_developer and user.company is not None and user.company.status == "suspended":
        raise ApiError(
            "This company workspace is suspended. Contact platform support.", 423, "company_suspended"
        )

    register_successful_login(user)
    start_session(user)
    audit("auth.login", entity="user", entity_id=user.id, summary=f"{user.full_name} signed in",
          company_id=user.company_id, commit=True)
    return jsonify(build_session_payload(user))


@bp.post("/register")
def register():
    """Self-service signup: create a company workspace and its owner."""
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "company_name": {"type": "str", "required": True, "min_len": 2, "max_len": 120,
                             "label": "Company name"},
            "full_name": {"type": "str", "required": True, "min_len": 2, "max_len": 120, "label": "Your name"},
            "email": {"type": "email", "required": True, "max_len": 180, "label": "Email"},
            "password": {"type": "text", "required": True, "min_len": 8, "max_len": 200,
                         "trim": False, "label": "Password"},
            "currency_code": {"type": "str", "default": "USD", "max_len": 6},
            "currency_symbol": {"type": "str", "default": "$", "max_len": 4},
            "vat_number": {"type": "str", "default": "", "max_len": 60},
            "company_reg_number": {"type": "str", "default": "", "max_len": 60},
        },
    )
    email = payload["email"].lower()
    if User.query.filter(db.func.lower(User.email) == email).first() is not None:
        raise bad_request("That email is already registered.", {"email": "Email already in use."})

    from app.services.provisioning import add_user, provision_company

    company = provision_company(
        payload["company_name"],
        status="trial",
        plan="starter",
        currency_code=payload["currency_code"],
        currency_symbol=payload["currency_symbol"] or "$",
        contact_email=email,
        timezone="Africa/Harare",
        settings_patch={
            "business": {
                "legal_name": payload["company_name"].strip(),
                "email": email,
                "country": "Zimbabwe",
                "tax_number": payload["vat_number"],
                "company_reg_number": payload["company_reg_number"],
            },
        },
    )
    owner = add_user(
        company,
        email=email,
        full_name=payload["full_name"],
        password=payload["password"],
        role=company.owner_role,
    )
    db.session.commit()

    start_session(owner)
    audit("company.created", entity="company", entity_id=company.id,
          summary=f"{company.name} signed up", company_id=company.id, commit=True)
    return jsonify(build_session_payload(owner)), 201


@bp.post("/logout")
@login_required
def logout():
    user = current_user()
    audit("auth.logout", entity="user", entity_id=user.id if user else None,
          summary="Signed out", company_id=user.company_id if user else None, commit=True)
    end_session()
    return jsonify({"ok": True, "csrf_token": csrf_token()})


@bp.post("/password")
@login_required
def change_password():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "current_password": {"type": "text", "required": True, "trim": False, "label": "Current password"},
            "new_password": {"type": "text", "required": True, "min_len": 8, "trim": False,
                             "label": "New password"},
        },
    )
    user = current_user()
    if not user.check_password(payload["current_password"]):
        raise bad_request("Your current password is not correct.", {"current_password": "Incorrect password."})
    user.set_password(payload["new_password"])
    db.session.commit()
    audit("auth.password_changed", entity="user", entity_id=user.id, summary="Password changed", commit=True)
    return jsonify({"ok": True})


@bp.post("/switch-user")
@login_required
def switch_user():
    """Hand the terminal to another staff member using their PIN."""
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "user_id": {"type": "int", "required": True},
            "pin": {"type": "text", "required": True, "trim": False, "max_len": 12},
        },
    )
    company = current_company()
    actor = current_user()
    if actor.is_developer:
        raise ApiError("Developers cannot take over a staff session. Use 'Enter company' instead.", 403, "forbidden")
    target = User.query.filter_by(id=payload["user_id"], company_id=company.id if company else None).first()
    if target is None or target.status != "active" or not target.check_pin(payload["pin"]):
        raise ApiError("That PIN is not right.", 401, "invalid_pin")
    if not actor.has_permission("users.manage"):
        raise ApiError("You cannot switch users.", 403, "forbidden")
    session["user_id"] = target.id
    db.session.commit()
    audit("auth.switch_user", entity="user", entity_id=target.id,
          summary=f"Terminal handed to {target.full_name}", commit=True)
    return jsonify(build_session_payload(target))


# --------------------------------------------------------------------------- #
# Developer workspace switching
# --------------------------------------------------------------------------- #
@bp.post("/enter-company/<int:company_id>")
@developer_required
def enter_company_workspace(company_id: int):
    company = db.session.get(Company, company_id)
    if company is None:
        raise ApiError("Company not found.", 404, "not_found")
    enter_company(company.id)
    user = current_user()
    audit("developer.enter_company", entity="company", entity_id=company.id,
          summary=f"Entered {company.name}", company_id=company.id, commit=True)
    return jsonify(build_session_payload(user))


@bp.post("/leave-company")
@developer_required
def leave_company_workspace():
    company = current_company()
    leave_company()
    user = current_user()
    if company is not None:
        audit("developer.leave_company", entity="company", entity_id=company.id,
              summary=f"Left {company.name}", company_id=company.id, commit=True)
    return jsonify(build_session_payload(user))


@bp.get("/permissions")
def permissions():
    return jsonify({"permissions": PERMISSIONS, "roles": [r["name"] for r in DEFAULT_ROLES]})
