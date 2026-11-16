"""Company workspace administration: settings, modules, staff and configuration."""

from __future__ import annotations

import re

from flask import Blueprint, jsonify, request

from app.blueprints.helpers import get_scoped
from app.defaults import DASHBOARD_WIDGETS, PERMISSIONS, default_settings
from app.extensions import db
from app.models import (
    AuditLog,
    CustomField,
    Customer,
    Discount,
    Location,
    PaymentMethod,
    Product,
    Register,
    Role,
    Sale,
    Supplier,
    TaxRate,
    User,
)
from app.modules import MODULE_BY_KEY, public_catalog
from app.security import (
    audit,
    bad_request,
    company_required,
    current_company,
    current_user,
    login_required,
    not_found,
    permission_required,
)
from app.utils import paginate, search_arg, slugify, validate

bp = Blueprint("company", __name__, url_prefix="/api/company")

HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

SETTINGS_SPEC: dict[str, dict[str, str]] = {
    "currency": {"code": "str", "symbol": "str", "position": "enum:before,after", "decimals": "int:0,3"},
    "business": {
        "legal_name": "str", "tax_number": "str", "company_reg_number": "str", "email": "str", "phone": "str",
        "website": "str", "address": "str", "city": "str", "country": "str",
    },
    "branding": {
        "logo_text": "str", "logo_data_url": "long", "primary": "color", "accent": "color",
        "theme": "enum:light,dark", "radius": "int:0,32", "density": "enum:comfortable,compact",
    },
    "sales": {
        "prefix": "str", "next_number": "int:1,99999999", "number_padding": "int:0,10",
        "default_tax_rate_id": "nullable_int", "default_payment_method_id": "nullable_int",
        "allow_zero_price": "bool", "show_out_of_stock": "bool",
    },
    "receipts": {"paper_width": "enum:58mm,80mm,A4", "header_note": "long", "terms": "long", "thank_you": "long"},
    "dashboard": {"widgets": "widgets"},
    "security": {"require_pin_for_override": "bool"},
}


def _coerce_setting(path: str, raw, spec: str):
    if spec == "str":
        value = str(raw)[:200]
    elif spec == "long":
        value = str(raw)[:400000]
    elif spec == "bool":
        value = bool(raw)
    elif spec == "color":
        value = str(raw)
        if not HEX.match(value):
            raise bad_request(f"{path} must be a hex colour like #5b5bd6.", {path: "Invalid colour."})
    elif spec.startswith("enum:"):
        options = spec.split(":", 1)[1].split(",")
        value = str(raw)
        if value not in options:
            raise bad_request(f"{path} must be one of {', '.join(options)}.", {path: "Invalid option."})
    elif spec.startswith("int:"):
        low, high = (int(part) for part in spec.split(":", 1)[1].split(","))
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise bad_request(f"{path} must be a whole number.", {path: "Invalid number."})
        if value < low or value > high:
            raise bad_request(f"{path} must be between {low} and {high}.", {path: "Out of range."})
    elif spec == "nullable_int":
        if raw in (None, ""):
            value = None
        else:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise bad_request(f"{path} must be a number.", {path: "Invalid number."})
    elif spec == "widgets":
        valid = {w["key"] for w in DASHBOARD_WIDGETS}
        if not isinstance(raw, list):
            raise bad_request("Dashboard widgets must be a list.", {path: "Invalid widget list."})
        value = [w for w in raw if w in valid][:12]
    else:  # pragma: no cover - developer guard
        raise ValueError(f"Unknown settings spec {spec}")
    return value


def sanitize_settings(patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise bad_request("Settings must be an object.")
    clean: dict = {}
    for section, values in patch.items():
        spec = SETTINGS_SPEC.get(section)
        if spec is None:
            continue
        if not isinstance(values, dict):
            continue
        clean[section] = {}
        for key, raw in values.items():
            if key not in spec:
                continue
            clean[section][key] = _coerce_setting(f"{section}.{key}", raw, spec[key])
    return clean


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
@bp.get("/settings")
@login_required
@company_required
@permission_required("settings.manage")
def get_settings():
    company = current_company()
    return jsonify(
        {
            "settings": company.settings,
            "modules": company.module_state,
            "module_catalog": public_catalog(),
            "dashboard_widgets": DASHBOARD_WIDGETS,
            "company": company.to_dict(detail=True),
        }
    )


@bp.patch("/settings")
@login_required
@company_required
@permission_required("settings.manage")
def update_settings():
    company = current_company()
    clean = sanitize_settings(request.get_json(silent=True) or {})
    if not clean:
        raise bad_request("Nothing to update.")
    company.update_settings(clean)
    db.session.commit()
    audit("settings.updated", entity="company", entity_id=company.id,
          summary=f"Updated {', '.join(clean)}", meta={"sections": list(clean)}, commit=True)
    return jsonify({"settings": company.settings, "company": company.to_dict(detail=True)})


@bp.patch("/profile")
@login_required
@company_required
@permission_required("settings.manage")
def update_profile():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "min_len": 2, "max_len": 120, "label": "Workspace name"},
            "contact_email": {"type": "email", "default": ""},
            "timezone": {"type": "str", "default": "UTC", "max_len": 64},
        },
    )
    company.name = payload["name"]
    company.contact_email = payload["contact_email"]
    company.timezone = payload["timezone"]
    db.session.commit()
    audit("company.profile_updated", entity="company", entity_id=company.id,
          summary="Workspace profile updated", commit=True)
    return jsonify({"company": company.to_dict(detail=True)})


@bp.post("/reset-settings")
@login_required
@company_required
@permission_required("settings.manage")
def reset_settings():
    company = current_company()
    section = (request.get_json(silent=True) or {}).get("section")
    defaults = default_settings()
    if section and section in defaults:
        company.update_settings({section: defaults[section]})
        audit("settings.reset", entity="company", entity_id=company.id,
              summary=f"Reset {section} settings", commit=True)
    else:
        company.settings_json = {}
        audit("settings.reset", entity="company", entity_id=company.id, summary="Reset all settings", commit=True)
    db.session.commit()
    return jsonify({"settings": company.settings})


# --------------------------------------------------------------------------- #
# Modules
# --------------------------------------------------------------------------- #
@bp.get("/modules")
@login_required
@company_required
def list_modules():
    company = current_company()
    return jsonify({"modules": company.module_state, "catalog": public_catalog()})


@bp.patch("/modules/<key>")
@login_required
@company_required
@permission_required("settings.manage")
def update_module(key: str):
    company = current_company()
    module = MODULE_BY_KEY.get(key)
    if module is None:
        not_found("Unknown module.")
    payload = request.get_json(silent=True) or {}
    if module.get("locked") and payload.get("enabled") is False:
        raise bad_request("This module is part of the core POS and cannot be disabled.")

    config_patch: dict = {}
    for field in module.get("schema", []):
        if field["key"] not in (payload.get("config") or {}):
            continue
        raw = payload["config"][field["key"]]
        kind = field["type"]
        if kind == "bool":
            value = bool(raw)
        elif kind == "number":
            try:
                value = float(raw)
            except (TypeError, ValueError):
                raise bad_request(f"{field['label']} must be a number.", {field["key"]: "Invalid number."})
            if "min" in field and value < field["min"]:
                raise bad_request(f"{field['label']} must be at least {field['min']}.", {field["key"]: "Too low."})
            if "max" in field and value > field["max"]:
                raise bad_request(f"{field['label']} must be at most {field['max']}.", {field["key"]: "Too high."})
            if float(value).is_integer():
                value = int(value)
        elif kind == "money":
            from app.utils import to_cents

            value = to_cents(raw)
        elif kind == "select":
            value = str(raw)
            if value not in field.get("options", []):
                raise bad_request(f"{field['label']} has an invalid option.", {field["key"]: "Invalid option."})
        elif kind == "tags":
            if isinstance(raw, str):
                items = [part.strip() for part in raw.split(",") if part.strip()]
            elif isinstance(raw, list):
                items = [str(item).strip() for item in raw if str(item).strip()]
            else:
                items = []
            value = []
            for item in items[:20]:
                try:
                    number = float(item)
                    value.append(int(number) if number.is_integer() else number)
                except (TypeError, ValueError):
                    value.append(item)
        else:
            value = str(raw)[:2000]
        config_patch[field["key"]] = value

    company.set_module(key, enabled=payload.get("enabled"), config=config_patch)
    db.session.commit()
    audit("module.updated", entity="module", entity_id=key,
          summary=f"{module['name']} {'enabled' if payload.get('enabled') else 'configured'}",
          meta={"enabled": payload.get("enabled"), "config": config_patch}, commit=True)
    return jsonify({"module": company.module_state.get(key), "modules": company.module_state})


# --------------------------------------------------------------------------- #
# Tax rates
# --------------------------------------------------------------------------- #
@bp.get("/taxes")
@login_required
@company_required
def list_taxes():
    company = current_company()
    rows = TaxRate.query.filter_by(company_id=company.id).order_by(TaxRate.name).all()
    return jsonify({"items": [t.to_dict() for t in rows]})


@bp.post("/taxes")
@login_required
@company_required
@permission_required("settings.manage")
def create_tax():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 60, "label": "Name"},
            "rate": {"type": "float", "required": True, "min": 0, "max": 100, "label": "Rate"},
            "is_default": {"type": "bool", "default": False},
            "is_inclusive": {"type": "bool", "default": False},
        },
    )
    tax = TaxRate(company_id=company.id, **payload)
    if payload["is_default"]:
        TaxRate.query.filter_by(company_id=company.id, is_default=True).update({"is_default": False})
    db.session.add(tax)
    db.session.commit()
    audit("tax.created", entity="tax", entity_id=tax.id, summary=f"Added tax {tax.name}", commit=True)
    return jsonify({"item": tax.to_dict()}), 201


@bp.patch("/taxes/<int:tax_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_tax(tax_id: int):
    company = current_company()
    tax = get_scoped(TaxRate, tax_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 60},
            "rate": {"type": "float", "min": 0, "max": 100},
            "is_default": {"type": "bool"},
            "is_inclusive": {"type": "bool"},
            "is_active": {"type": "bool"},
        },
    )
    if payload.get("is_default"):
        TaxRate.query.filter(TaxRate.company_id == company.id, TaxRate.id != tax.id).update(
            {"is_default": False}
        )
    for key, value in payload.items():
        setattr(tax, key, value)
    db.session.commit()
    audit("tax.updated", entity="tax", entity_id=tax.id, summary=f"Updated tax {tax.name}", commit=True)
    return jsonify({"item": tax.to_dict()})


@bp.delete("/taxes/<int:tax_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_tax(tax_id: int):
    company = current_company()
    tax = get_scoped(TaxRate, tax_id, company.id)
    linked = Product.query.filter_by(company_id=company.id, tax_rate_id=tax.id).count()
    if linked:
        raise bad_request(f"{linked} products still use this tax rate. Reassign them first.")
    db.session.delete(tax)
    db.session.commit()
    audit("tax.deleted", entity="tax", entity_id=tax_id, summary=f"Deleted tax {tax.name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Payment methods
# --------------------------------------------------------------------------- #
@bp.get("/payment-methods")
@login_required
@company_required
def list_payment_methods():
    company = current_company()
    rows = (
        PaymentMethod.query.filter_by(company_id=company.id)
        .order_by(PaymentMethod.sort_order, PaymentMethod.name)
        .all()
    )
    return jsonify({"items": [m.to_dict() for m in rows]})


@bp.post("/payment-methods")
@login_required
@company_required
@permission_required("settings.manage")
def create_payment_method():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 60, "label": "Name"},
            "type": {"type": "str", "default": "cash", "choices": ["cash", "card", "mobile", "bank", "credit", "other"]},
            "icon": {"type": "str", "default": "cash", "max_len": 40},
            "requires_reference": {"type": "bool", "default": False},
            "opens_drawer": {"type": "bool", "default": False},
            "is_active": {"type": "bool", "default": True},
            "sort_order": {"type": "int", "default": 100, "min": 0, "max": 9999},
        },
    )
    method = PaymentMethod(company_id=company.id, **payload)
    db.session.add(method)
    db.session.commit()
    audit("payment_method.created", entity="payment_method", entity_id=method.id,
          summary=f"Added {method.name}", commit=True)
    return jsonify({"item": method.to_dict()}), 201


@bp.patch("/payment-methods/<int:method_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_payment_method(method_id: int):
    company = current_company()
    method = get_scoped(PaymentMethod, method_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 60},
            "type": {"type": "str", "choices": ["cash", "card", "mobile", "bank", "credit", "other"]},
            "icon": {"type": "str", "max_len": 40},
            "requires_reference": {"type": "bool"},
            "opens_drawer": {"type": "bool"},
            "is_active": {"type": "bool"},
            "sort_order": {"type": "int", "min": 0, "max": 9999},
        },
    )
    for key, value in payload.items():
        setattr(method, key, value)
    db.session.commit()
    audit("payment_method.updated", entity="payment_method", entity_id=method.id,
          summary=f"Updated {method.name}", commit=True)
    return jsonify({"item": method.to_dict()})


@bp.delete("/payment-methods/<int:method_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_payment_method(method_id: int):
    company = current_company()
    method = get_scoped(PaymentMethod, method_id, company.id)
    remaining = PaymentMethod.query.filter(
        PaymentMethod.company_id == company.id,
        PaymentMethod.id != method.id,
        PaymentMethod.is_active.is_(True),
    ).count()
    if remaining == 0:
        raise bad_request("Keep at least one active payment method.")
    db.session.delete(method)
    db.session.commit()
    audit("payment_method.deleted", entity="payment_method", entity_id=method_id,
          summary=f"Deleted {method.name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Locations and registers
# --------------------------------------------------------------------------- #
@bp.get("/locations")
@login_required
@company_required
def list_locations():
    company = current_company()
    rows = Location.query.filter_by(company_id=company.id).order_by(Location.name).all()
    registers = Register.query.filter_by(company_id=company.id).order_by(Register.name).all()
    return jsonify({"items": [r.to_dict() for r in rows], "registers": [r.to_dict() for r in registers]})


@bp.post("/locations")
@login_required
@company_required
@permission_required("settings.manage")
def create_location():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 120, "label": "Name"},
            "code": {"type": "str", "default": "", "max_len": 20},
            "address": {"type": "str", "default": "", "max_len": 240},
            "phone": {"type": "str", "default": "", "max_len": 40},
            "is_default": {"type": "bool", "default": False},
            "is_active": {"type": "bool", "default": True},
        },
    )
    if payload.get("is_default"):
        Location.query.filter_by(company_id=company.id, is_default=True).update({"is_default": False})
    location = Location(company_id=company.id, **payload)
    db.session.add(location)
    db.session.commit()
    audit("location.created", entity="location", entity_id=location.id,
          summary=f"Added location {location.name}", commit=True)
    return jsonify({"item": location.to_dict()}), 201


@bp.patch("/locations/<int:location_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_location(location_id: int):
    company = current_company()
    location = get_scoped(Location, location_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 120},
            "code": {"type": "str", "max_len": 20},
            "address": {"type": "str", "max_len": 240},
            "phone": {"type": "str", "max_len": 40},
            "is_default": {"type": "bool"},
            "is_active": {"type": "bool"},
        },
    )
    if payload.get("is_default"):
        Location.query.filter(
            Location.company_id == company.id, Location.id != location.id
        ).update({"is_default": False})
    for key, value in payload.items():
        setattr(location, key, value)
    db.session.commit()
    return jsonify({"item": location.to_dict()})


@bp.delete("/locations/<int:location_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_location(location_id: int):
    company = current_company()
    location = get_scoped(Location, location_id, company.id)
    if len(location.registers):
        raise bad_request("Remove the registers in this location first.")
    db.session.delete(location)
    db.session.commit()
    audit("location.deleted", entity="location", entity_id=location_id,
          summary=f"Deleted location {location.name}", commit=True)
    return jsonify({"ok": True})


@bp.post("/registers")
@login_required
@company_required
@permission_required("settings.manage")
def create_register():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 80, "label": "Name"},
            "code": {"type": "str", "default": "", "max_len": 20},
            "location_id": {"type": "int", "default": None},
            "is_active": {"type": "bool", "default": True},
        },
    )
    register = Register(company_id=company.id, **payload)
    db.session.add(register)
    db.session.commit()
    audit("register.created", entity="register", entity_id=register.id,
          summary=f"Added register {register.name}", commit=True)
    return jsonify({"item": register.to_dict()}), 201


@bp.patch("/registers/<int:register_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_register(register_id: int):
    company = current_company()
    register = get_scoped(Register, register_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 80},
            "code": {"type": "str", "max_len": 20},
            "location_id": {"type": "int"},
            "is_active": {"type": "bool"},
        },
    )
    if payload.get("location_id"):
        get_scoped(Location, payload["location_id"], company.id)
    for key, value in payload.items():
        setattr(register, key, value)
    db.session.commit()
    audit("register.updated", entity="register", entity_id=register.id,
          summary=f"Updated register {register.name}", commit=True)
    return jsonify({"item": register.to_dict()})


@bp.delete("/registers/<int:register_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_register(register_id: int):
    company = current_company()
    register = get_scoped(Register, register_id, company.id)
    db.session.delete(register)
    db.session.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Roles
# --------------------------------------------------------------------------- #
@bp.get("/roles")
@login_required
@company_required
def list_roles():
    company = current_company()
    rows = Role.query.filter_by(company_id=company.id).order_by(Role.name).all()
    return jsonify({"items": [r.to_dict() for r in rows], "permissions": PERMISSIONS})


@bp.post("/roles")
@login_required
@company_required
@permission_required("users.manage")
def create_role():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 60, "label": "Role name"},
            "description": {"type": "str", "default": "", "max_len": 200},
            "permissions": {"type": "json", "default": []},
        },
    )
    valid = {p["key"] for p in PERMISSIONS}
    permissions = [p for p in payload["permissions"] if p in valid]
    if Role.query.filter_by(company_id=company.id, name=payload["name"]).first():
        raise bad_request("A role with that name already exists.", {"name": "Name already used."})
    role = Role(
        company_id=company.id,
        name=payload["name"],
        description=payload["description"],
        permissions=permissions,
        is_system=False,
    )
    db.session.add(role)
    db.session.commit()
    audit("role.created", entity="role", entity_id=role.id, summary=f"Created role {role.name}", commit=True)
    return jsonify({"item": role.to_dict()}), 201


@bp.patch("/roles/<int:role_id>")
@login_required
@company_required
@permission_required("users.manage")
def update_role(role_id: int):
    company = current_company()
    role = get_scoped(Role, role_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 60},
            "description": {"type": "str", "max_len": 200},
            "permissions": {"type": "json"},
        },
    )
    if role.name == "Administrator" and "permissions" in payload:
        raise bad_request("The Administrator role always keeps every permission.")
    if "name" in payload:
        role.name = payload["name"]
    if "description" in payload:
        role.description = payload["description"]
    if "permissions" in payload:
        valid = {p["key"] for p in PERMISSIONS}
        role.permissions = [p for p in payload["permissions"] if p in valid]
    db.session.commit()
    audit("role.updated", entity="role", entity_id=role.id, summary=f"Updated role {role.name}", commit=True)
    return jsonify({"item": role.to_dict()})


@bp.delete("/roles/<int:role_id>")
@login_required
@company_required
@permission_required("users.manage")
def delete_role(role_id: int):
    company = current_company()
    role = get_scoped(Role, role_id, company.id)
    if role.is_system or role.name == "Administrator":
        raise bad_request("System roles cannot be deleted.")
    if role.users:
        raise bad_request("Move the staff in this role to another role first.")
    db.session.delete(role)
    db.session.commit()
    audit("role.deleted", entity="role", entity_id=role_id, summary=f"Deleted role {role.name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #
@bp.get("/users")
@login_required
@company_required
def list_users():
    company = current_company()
    rows = User.query.filter_by(company_id=company.id).order_by(User.full_name).all()
    roles = Role.query.filter_by(company_id=company.id).order_by(Role.name).all()
    return jsonify(
        {
            "items": [u.to_dict(include_company=False) for u in rows],
            "roles": [r.to_dict() for r in roles],
            "permissions": PERMISSIONS,
        }
    )


@bp.post("/users")
@login_required
@company_required
@permission_required("users.manage")
def create_user():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "full_name": {"type": "str", "required": True, "min_len": 2, "max_len": 120, "label": "Full name"},
            "email": {"type": "email", "required": True, "max_len": 180, "label": "Email"},
            "password": {"type": "text", "required": True, "min_len": 8, "trim": False, "label": "Password"},
            "role_id": {"type": "int", "required": True, "label": "Role"},
            "phone": {"type": "str", "default": "", "max_len": 40},
            "pin": {"type": "text", "default": "", "max_len": 12, "trim": False},
            "status": {"type": "str", "default": "active", "choices": ["active", "invited", "disabled"]},
            "avatar_color": {"type": "str", "default": "#5b5bd6", "max_len": 20},
        },
    )
    if User.query.filter(db.func.lower(User.email) == payload["email"].lower()).first():
        raise bad_request("That email is already registered.", {"email": "Email already in use."})
    role = get_scoped(Role, payload["role_id"], company.id)
    user = User(
        company_id=company.id,
        role_id=role.id,
        email=payload["email"].lower(),
        full_name=payload["full_name"],
        phone=payload["phone"],
        status=payload["status"],
        avatar_color=payload["avatar_color"],
    )
    user.set_password(payload["password"])
    if payload.get("pin"):
        user.set_pin(payload["pin"])
    db.session.add(user)
    db.session.commit()
    audit("user.created", entity="user", entity_id=user.id,
          summary=f"Added {user.full_name} as {role.name}", commit=True)
    return jsonify({"item": user.to_dict(include_company=False)}), 201


@bp.patch("/users/<int:user_id>")
@login_required
@company_required
@permission_required("users.manage")
def update_user(user_id: int):
    company = current_company()
    user = get_scoped(User, user_id, company.id)
    if user.is_developer:
        raise bad_request("Platform accounts cannot be edited here.")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "full_name": {"type": "str", "max_len": 120},
            "email": {"type": "email", "max_len": 180},
            "role_id": {"type": "int"},
            "phone": {"type": "str", "max_len": 40},
            "status": {"type": "str", "choices": ["active", "invited", "disabled"]},
            "password": {"type": "text", "min_len": 8, "trim": False},
            "pin": {"type": "text", "max_len": 12, "trim": False},
            "avatar_color": {"type": "str", "max_len": 20},
        },
    )
    actor = current_user()
    if user.id == actor.id and payload.get("status") == "disabled":
        raise bad_request("You cannot disable your own account.")
    if "role_id" in payload:
        role = get_scoped(Role, payload["role_id"], company.id)
        user.role_id = role.id
    if "email" in payload:
        email = payload["email"].lower()
        clash = User.query.filter(db.func.lower(User.email) == email, User.id != user.id).first()
        if clash:
            raise bad_request("That email belongs to another account.", {"email": "Email already in use."})
        user.email = email
    for field in ("full_name", "phone", "status", "avatar_color"):
        if field in payload:
            setattr(user, field, payload[field])
    if payload.get("password"):
        user.set_password(payload["password"])
    if "pin" in payload:
        user.set_pin(payload["pin"] or None)
    db.session.commit()
    audit("user.updated", entity="user", entity_id=user.id, summary=f"Updated {user.full_name}", commit=True)
    return jsonify({"item": user.to_dict(include_company=False)})


@bp.delete("/users/<int:user_id>")
@login_required
@company_required
@permission_required("users.manage")
def delete_user(user_id: int):
    company = current_company()
    user = get_scoped(User, user_id, company.id)
    actor = current_user()
    if user.id == actor.id:
        raise bad_request("You cannot delete your own account.")
    if user.is_developer:
        raise bad_request("Platform accounts cannot be deleted here.")
    administrators = [u for u in company.users if u.role and u.role.name == "Administrator"]
    if user.role and user.role.name == "Administrator":
        if not actor.is_developer:
            raise bad_request(
                "Administrators can only remove ordinary staff. Ask platform support to remove another administrator.",
                {"user": "Only platform staff can remove administrators."},
            )
        if len(administrators) <= 1:
            raise bad_request("A workspace needs at least one administrator.")
    Sale.query.filter_by(company_id=company.id, user_id=user.id).update({"user_id": None})
    db.session.delete(user)
    db.session.commit()
    audit("user.deleted", entity="user", entity_id=user_id, summary=f"Removed {user.full_name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Custom fields
# --------------------------------------------------------------------------- #
@bp.get("/custom-fields")
@login_required
@company_required
def list_custom_fields():
    company = current_company()
    rows = CustomField.query.filter_by(company_id=company.id).order_by(CustomField.sort_order).all()
    return jsonify({"items": [f.to_dict() for f in rows]})


@bp.post("/custom-fields")
@login_required
@company_required
@permission_required("settings.manage")
def create_custom_field():
    company = current_company()
    if not company.module_enabled("custom_fields"):
        raise bad_request("Enable the Custom Fields module first.")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "entity": {"type": "str", "required": True, "choices": ["product", "customer"], "label": "Applies to"},
            "label": {"type": "str", "required": True, "max_len": 80, "label": "Label"},
            "type": {"type": "str", "default": "text",
                     "choices": ["text", "number", "select", "date", "bool", "textarea"]},
            "options": {"type": "json", "default": []},
            "required": {"type": "bool", "default": False},
            "sort_order": {"type": "int", "default": 100, "min": 0, "max": 9999},
        },
    )
    key = slugify(payload["label"], "field").replace("-", "_")[:60]
    if CustomField.query.filter_by(company_id=company.id, entity=payload["entity"], key=key).first():
        raise bad_request("A field with that label already exists.", {"label": "Label already used."})
    if payload["type"] == "select":
        options = payload["options"] if isinstance(payload["options"], list) else []
        options = [str(option)[:60] for option in options][:30]
        if not options:
            raise bad_request("Add at least one option.", {"options": "Options are required."})
    else:
        options = []
    field = CustomField(
        company_id=company.id,
        entity=payload["entity"],
        key=key,
        label=payload["label"],
        type=payload["type"],
        options=options,
        required=payload["required"],
        sort_order=payload["sort_order"],
    )
    db.session.add(field)
    db.session.commit()
    audit("custom_field.created", entity="custom_field", entity_id=field.id,
          summary=f"Added field {field.label}", commit=True)
    return jsonify({"item": field.to_dict()}), 201


@bp.delete("/custom-fields/<int:field_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_custom_field(field_id: int):
    company = current_company()
    field = get_scoped(CustomField, field_id, company.id)
    db.session.delete(field)
    db.session.commit()
    audit("custom_field.deleted", entity="custom_field", entity_id=field_id,
          summary=f"Removed field {field.label}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Discounts
# --------------------------------------------------------------------------- #
@bp.get("/discounts")
@login_required
@company_required
def list_discounts():
    company = current_company()
    rows = Discount.query.filter_by(company_id=company.id).order_by(Discount.created_at.desc()).all()
    return jsonify({"items": [d.to_dict() for d in rows]})


@bp.post("/discounts")
@login_required
@company_required
@permission_required("discounts.manage")
def create_discount():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 120, "label": "Name"},
            "code": {"type": "str", "default": "", "max_len": 40},
            "type": {"type": "str", "default": "percent", "choices": ["percent", "fixed"]},
            "value": {"type": "float", "required": True, "min": 0, "label": "Value"},
            "min_subtotal": {"type": "money", "default": 0},
            "max_uses": {"type": "int", "default": 0, "min": 0},
            "is_active": {"type": "bool", "default": True},
        },
    )
    code = payload["code"].upper().strip()
    if code and Discount.query.filter_by(company_id=company.id, code=code).first():
        raise bad_request("That code is already in use.", {"code": "Code already used."})
    if payload["type"] == "percent" and payload["value"] > 100:
        raise bad_request("A percentage discount cannot exceed 100%.", {"value": "Too high."})
    if payload["type"] == "fixed" and payload["value"] > 1000000:
        raise bad_request("That fixed discount is too large.", {"value": "Too large."})
    discount = Discount(
        company_id=company.id,
        name=payload["name"],
        code=code,
        type=payload["type"],
        value=payload["value"],
        min_subtotal_cents=payload["min_subtotal"],
        max_uses=payload["max_uses"],
        is_active=payload["is_active"],
    )
    db.session.add(discount)
    db.session.commit()
    audit("discount.created", entity="discount", entity_id=discount.id,
          summary=f"Created promotion {discount.name}", commit=True)
    return jsonify({"item": discount.to_dict()}), 201


@bp.patch("/discounts/<int:discount_id>")
@login_required
@company_required
@permission_required("discounts.manage")
def update_discount(discount_id: int):
    company = current_company()
    discount = get_scoped(Discount, discount_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 120},
            "code": {"type": "str", "max_len": 40},
            "type": {"type": "str", "choices": ["percent", "fixed"]},
            "value": {"type": "float", "min": 0},
            "min_subtotal": {"type": "money"},
            "max_uses": {"type": "int", "min": 0},
            "is_active": {"type": "bool"},
        },
    )
    if "min_subtotal" in payload:
        discount.min_subtotal_cents = payload.pop("min_subtotal")
    if "code" in payload:
        discount.code = payload.pop("code").upper().strip()
    for key, value in payload.items():
        setattr(discount, key, value)
    db.session.commit()
    audit("discount.updated", entity="discount", entity_id=discount.id,
          summary=f"Updated promotion {discount.name}", commit=True)
    return jsonify({"item": discount.to_dict()})


@bp.delete("/discounts/<int:discount_id>")
@login_required
@company_required
@permission_required("discounts.manage")
def delete_discount(discount_id: int):
    company = current_company()
    discount = get_scoped(Discount, discount_id, company.id)
    db.session.delete(discount)
    db.session.commit()
    audit("discount.deleted", entity="discount", entity_id=discount_id,
          summary=f"Deleted promotion {discount.name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Suppliers
# --------------------------------------------------------------------------- #
@bp.get("/suppliers")
@login_required
@company_required
def list_suppliers():
    company = current_company()
    rows = Supplier.query.filter_by(company_id=company.id).order_by(Supplier.name).all()
    return jsonify({"items": [s.to_dict() for s in rows]})


@bp.post("/suppliers")
@login_required
@company_required
@permission_required("inventory.manage")
def create_supplier():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 120, "label": "Supplier name"},
            "contact_name": {"type": "str", "default": "", "max_len": 120},
            "email": {"type": "str", "default": "", "max_len": 180},
            "phone": {"type": "str", "default": "", "max_len": 40},
            "address": {"type": "str", "default": "", "max_len": 240},
            "notes": {"type": "str", "default": "", "max_len": 2000},
        },
    )
    supplier = Supplier(company_id=company.id, **payload)
    db.session.add(supplier)
    db.session.commit()
    audit("supplier.created", entity="supplier", entity_id=supplier.id,
          summary=f"Added supplier {supplier.name}", commit=True)
    return jsonify({"item": supplier.to_dict()}), 201


@bp.delete("/suppliers/<int:supplier_id>")
@login_required
@company_required
@permission_required("inventory.manage")
def delete_supplier(supplier_id: int):
    company = current_company()
    supplier = get_scoped(Supplier, supplier_id, company.id)
    db.session.delete(supplier)
    db.session.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Audit log & onboarding
# --------------------------------------------------------------------------- #
@bp.get("/audit")
@login_required
@company_required
@permission_required("audit.view")
def audit_log():
    company = current_company()
    query = AuditLog.query.filter_by(company_id=company.id)
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(
            db.or_(
                AuditLog.action.ilike(like),
                AuditLog.summary.ilike(like),
                AuditLog.actor_name.ilike(like),
            )
        )
    action = request.args.get("action")
    if action:
        query = query.filter(AuditLog.action == action)
    items, meta = paginate(query.order_by(AuditLog.created_at.desc()), default_per_page=40)
    return jsonify({"items": [i.to_dict() for i in items], "meta": meta})


@bp.get("/onboarding")
@login_required
@company_required
def onboarding():
    company = current_company()
    products = Product.query.filter_by(company_id=company.id).count()
    customers = Customer.query.filter_by(company_id=company.id).count()
    sales = Sale.query.filter_by(company_id=company.id).count()
    taxes = TaxRate.query.filter_by(company_id=company.id).count()
    methods = PaymentMethod.query.filter_by(company_id=company.id, is_active=True).count()
    staff = User.query.filter_by(company_id=company.id).count()
    enabled_modules = len(company.enabled_module_keys)
    branding = company.settings.get("branding", {})

    steps = [
        {"key": "branding", "label": "Make it yours", "hint": "Set your colours and logo",
         "done": bool(branding.get("primary") and branding.get("logo_text")), "route": "#/settings/branding"},
        {"key": "taxes", "label": "Add a tax rate", "hint": "So receipts show the right tax",
         "done": taxes > 0, "route": "#/settings/taxes"},
        {"key": "payments", "label": "Choose payment methods", "hint": "Cash, card, mobile money",
         "done": methods > 0, "route": "#/settings/payments"},
        {"key": "modules", "label": "Switch on modules", "hint": "Only pay attention to what you need",
         "done": enabled_modules >= 5, "route": "#/settings/modules"},
        {"key": "products", "label": "Add your first products", "hint": "Build the catalog you sell",
         "done": products > 0, "route": "#/products"},
        {"key": "staff", "label": "Invite your team", "hint": "Give everyone the right permissions",
         "done": staff > 1, "route": "#/settings/users"},
        {"key": "customers", "label": "Add a customer", "hint": "Start building relationships",
         "done": customers > 0, "route": "#/customers"},
        {"key": "sale", "label": "Take your first sale", "hint": "Open the POS and check out",
         "done": sales > 0, "route": "#/pos"},
    ]
    completed = sum(1 for step in steps if step["done"])
    return jsonify(
        {
            "steps": steps,
            "completed": completed,
            "total": len(steps),
            "percent": round((completed / len(steps)) * 100),
            "dismissed": bool(company.settings.get("onboarding", {}).get("dismissed")),
        }
    )


@bp.post("/onboarding/dismiss")
@login_required
@company_required
def dismiss_onboarding():
    company = current_company()
    company.update_settings({"onboarding": {"dismissed": True}})
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/receipt-preview")
@login_required
@company_required
@permission_required("settings.manage", "pos.sell")
def receipt_preview():
    """Render a sample receipt with the company's current receipt design."""
    from flask import Response

    from app.models import Sale as SaleModel
    from app.models import SaleItem, SalePayment
    from app.services.receipt import render_receipt
    from app.utils import utcnow

    company = current_company()
    sample_items = [
        ("Sample Espresso", "SKU-1001", 2, 250, 0, 15.0, 65, 500),
        ("Almond Croissant", "SKU-1002", 1, 320, 0, 15.0, 42, 320),
        ("House Beans 250g", "SKU-1015", 1, 1200, 100, 15.0, 143, 1100),
    ]
    subtotal = sum(item[3] * item[2] for item in sample_items)
    discount = sum(item[4] for item in sample_items)
    tax = sum(item[6] for item in sample_items)
    total = subtotal - discount + tax

    sale = SaleModel(
        company_id=company.id,
        number="PREVIEW-0001",
        status="completed",
        subtotal_cents=subtotal - discount,
        discount_cents=discount,
        tax_cents=tax,
        total_cents=total,
        paid_cents=total,
        created_at=utcnow(),
        note="Sample receipt preview",
        discount_label="Preview discount" if discount else "",
    )
    for name, sku, qty, price, disc, rate, tax_cents, line_total in sample_items:
        sale.items.append(
            SaleItem(
                name=name,
                sku=sku,
                qty=qty,
                unit_price_cents=price,
                discount_cents=disc,
                tax_rate_percent=rate,
                tax_cents=tax_cents,
                line_subtotal_cents=price * qty,
                line_total_cents=line_total + tax_cents,
            )
        )
    method = (
        PaymentMethod.query.filter_by(company_id=company.id, is_active=True).first()
    )
    sale.payments.append(
        SalePayment(
            method_id=method.id if method else None,
            method_name=method.name if method else "Cash",
            method_type=method.type if method else "cash",
            amount_cents=total,
            tendered_cents=total,
        )
    )
    html = render_receipt(company, sale)
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    )
    return response
