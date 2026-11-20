"""Authentication, self-service signup and the session bootstrap payload."""

from __future__ import annotations

from flask import Blueprint, jsonify, request, session

from app.defaults import (
    DASHBOARD_WIDGETS,
    PERMISSIONS,
    PREFERENCE_DENSITIES,
    PREFERENCE_SIDEBARS,
    PREFERENCE_THEMES,
)
from app.extensions import db
from app.models import Announcement, Company, Location, User
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
        "locations": [
            row.to_dict()
            for row in Location.query.filter_by(company_id=company.id, is_active=True).order_by(Location.name)
        ] if company else [],
        "modules": company.module_state if company else {},
        "module_catalog": public_catalog(),
        "permissions_catalog": PERMISSIONS,
        "dashboard_widgets": DASHBOARD_WIDGETS,
        "preferences": user.preferences,
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
            "whatsapp_number": {"type": "str", "default": "", "max_len": 40},
            # Off by default: a sign-in email is personal unless the owner says the
            # company uses it too (receipts, reports, contact address).
            "email_is_company_email": {"type": "bool", "default": False},
        },
    )
    email = payload["email"].lower()
    if User.query.filter(db.func.lower(User.email) == email).first() is not None:
        raise bad_request("That email is already registered.", {"email": "Email already in use."})

    from app.services import whatsapp
    from app.services.provisioning import add_user, provision_company

    whatsapp_number = ""
    if str(payload.get("whatsapp_number") or "").strip():
        try:
            whatsapp_number = whatsapp.normalise_number(payload["whatsapp_number"])
        except ValueError as error:
            raise bad_request(str(error), {"whatsapp_number": str(error)}) from error

    company = provision_company(
        payload["company_name"],
        status="trial",
        plan="starter",
        currency_code=payload["currency_code"],
        currency_symbol=payload["currency_symbol"] or "$",
        contact_email=email if payload["email_is_company_email"] else "",
        timezone="Africa/Harare",
        settings_patch={
            "business": {
                "legal_name": payload["company_name"].strip(),
                "email": email if payload["email_is_company_email"] else "",
                "country": "Zimbabwe",
                "tax_number": payload["vat_number"],
                "company_reg_number": payload["company_reg_number"],
                "whatsapp_number": whatsapp_number,
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
    if whatsapp_number:
        from app.models import ReportRecipient

        db.session.add(
            ReportRecipient(
                company_id=company.id,
                user_id=owner.id,
                name=owner.full_name,
                whatsapp_number=whatsapp_number,
                role_label="Workspace owner",
            )
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
            "current_password": {"type": "text", "default": "", "trim": False, "label": "Current password"},
            "new_password": {"type": "text", "required": True, "min_len": 8, "trim": False,
                             "label": "New password"},
        },
    )
    user = current_user()
    # First sign-in: they just proved the temporary password at login, so only the
    # new one is required. Every later change still asks for the current password.
    first_run = bool(user.must_change_password)
    if not first_run:
        if not payload.get("current_password"):
            raise bad_request("Enter your current password.", {"current_password": "Required."})
        if not user.check_password(payload["current_password"]):
            raise bad_request("Your current password is not correct.", {"current_password": "Incorrect password."})
    if user.check_password(payload["new_password"]):
        raise bad_request("Choose a password you have not used before.",
                          {"new_password": "Pick a different password."})
    user.set_password(payload["new_password"])
    user.must_change_password = False
    db.session.commit()
    audit("auth.password_changed", entity="user", entity_id=user.id,
          summary="Password set at first sign-in" if first_run else "Password changed", commit=True)
    return jsonify({"ok": True, "item": user.to_dict(include_company=False)})


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
# Personal preferences
# --------------------------------------------------------------------------- #
def sanitize_preferences(patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise bad_request("Preferences must be an object.")
    clean: dict = {}
    choices = {
        "theme": (PREFERENCE_THEMES, "Light, dark or blank to follow the workspace."),
        "density": (PREFERENCE_DENSITIES, "Comfortable, compact or blank to follow the workspace."),
        "sidebar": (PREFERENCE_SIDEBARS, "Expanded, collapsed or blank to follow the workspace."),
    }
    for key, (allowed, hint) in choices.items():
        if key not in patch:
            continue
        value = str(patch.get(key) or "")
        if value not in allowed:
            raise bad_request(hint, {key: "Invalid option."})
        clean[key] = value

    if "dashboard_widgets" in patch:
        raw = patch.get("dashboard_widgets")
        if raw is None:
            clean["dashboard_widgets"] = None
        elif isinstance(raw, list):
            valid = {widget["key"] for widget in DASHBOARD_WIDGETS}
            clean["dashboard_widgets"] = [key for key in raw if key in valid][:12]
        else:
            raise bad_request("Dashboard widgets must be a list.", {"dashboard_widgets": "Invalid list."})

    if "pos" in patch:
        raw = patch.get("pos")
        if not isinstance(raw, dict):
            raise bad_request("POS preferences must be an object.", {"pos": "Invalid object."})
        pos: dict = {}
        for key in ("sound_enabled", "auto_print"):
            if key not in raw:
                continue
            value = raw[key]
            if value is None:
                pos[key] = None
            elif isinstance(value, bool):
                pos[key] = value
            else:
                raise bad_request("POS preferences must be on, off or unset.", {"pos": "Invalid value."})
        if pos:
            clean["pos"] = pos
    return clean


@bp.get("/preferences")
@login_required
def read_preferences():
    return jsonify({"preferences": current_user().preferences, "dashboard_widgets": DASHBOARD_WIDGETS})


@bp.patch("/preferences")
@login_required
def update_preferences():
    user = current_user()
    clean = sanitize_preferences(request.get_json(silent=True) or {})
    if not clean:
        raise bad_request("Nothing to update.")
    preferences = user.update_preferences(clean)
    db.session.commit()
    return jsonify({"preferences": preferences})


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
