"""Platform (developer) console: manage every company and user on the system."""

from __future__ import annotations

from datetime import timedelta

from flask import Blueprint, jsonify, request

from app.blueprints.helpers import get_scoped
from app.defaults import DASHBOARD_WIDGETS, PERMISSIONS
from app.extensions import db
from app.models import (
    Announcement,
    AuditLog,
    Company,
    CompanyModule,
    CustomField,
    CustomWorkspace,
    Customer,
    Discount,
    HeldCart,
    Layby,
    LaybyItem,
    LaybyPayment,
    Location,
    PaymentMethod,
    Product,
    Refund,
    RefundItem,
    Register,
    Role,
    Sale,
    SaleItem,
    SalePayment,
    Shift,
    StockMovement,
    Supplier,
    TaxRate,
    User,
    WorkspaceRecord,
)
from app.modules import MODULE_CATALOG, public_catalog
from app.security import audit, bad_request, developer_required
from app.services.provisioning import add_user, provision_company
from app.utils import iso, paginate, search_arg, utcnow, validate

bp = Blueprint("developer", __name__, url_prefix="/api/developer")

PLANS = ["starter", "growth", "scale", "unlimited"]


def _platform_stats() -> dict:
    companies = Company.query.count()
    users = User.query.filter(User.is_developer.is_(False)).count()
    sales = Sale.query.count()
    revenue = db.session.query(db.func.coalesce(db.func.sum(Sale.total_cents), 0)).scalar() or 0
    products = Product.query.count()
    since = utcnow() - timedelta(days=30)
    active = (
        db.session.query(db.func.count(db.func.distinct(Sale.company_id)))
        .filter(Sale.created_at >= since)
        .scalar()
        or 0
    )
    suspended = Company.query.filter_by(status="suspended").count()
    return {
        "companies": companies,
        "active_companies_30d": int(active),
        "suspended_companies": suspended,
        "users": users,
        "sales": sales,
        "gross_volume_cents": int(revenue),
        "products": products,
        "modules_available": len(MODULE_CATALOG),
    }


@bp.get("/overview")
@developer_required
def overview():
    companies = Company.query.order_by(Company.created_at.desc()).limit(6).all()
    recent_sales = Sale.query.order_by(Sale.created_at.desc()).limit(8).all()
    recent_audit = AuditLog.query.order_by(AuditLog.created_at.desc()).limit(10).all()
    growth_rows = (
        db.session.query(
            db.func.date(Sale.created_at).label("day"),
            db.func.coalesce(db.func.sum(Sale.total_cents), 0),
            db.func.count(Sale.id),
        )
        .filter(Sale.created_at >= utcnow() - timedelta(days=29))
        .group_by("day")
        .order_by("day")
        .all()
    )
    return jsonify(
        {
            "stats": _platform_stats(),
            "companies": [c.to_dict() for c in companies],
            "recent_sales": [s.to_dict() for s in recent_sales],
            "recent_audit": [a.to_dict() for a in recent_audit],
            "growth": [
                {"date": str(row[0]), "sales_cents": int(row[1]), "transactions": int(row[2])}
                for row in growth_rows
            ],
            "plans": PLANS,
        }
    )


# --------------------------------------------------------------------------- #
# Companies
# --------------------------------------------------------------------------- #
@bp.get("/companies")
@developer_required
def list_companies():
    query = Company.query
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(db.or_(Company.name.ilike(like), Company.slug.ilike(like)))
    status = request.args.get("status")
    if status:
        query = query.filter(Company.status == status)
    items, meta = paginate(query.order_by(Company.created_at.desc()), default_per_page=25)

    payload = []
    for company in items:
        data = company.to_dict()
        data["sales_cents"] = int(
            db.session.query(db.func.coalesce(db.func.sum(Sale.total_cents), 0))
            .filter(Sale.company_id == company.id)
            .scalar()
            or 0
        )
        data["product_count"] = Product.query.filter_by(company_id=company.id).count()
        data["modules_enabled"] = sum(1 for state in company.module_state.values() if state["enabled"])
        payload.append(data)
    return jsonify({"items": payload, "meta": meta, "plans": PLANS})


@bp.post("/companies")
@developer_required
def create_company():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "min_len": 2, "max_len": 120, "label": "Company name"},
            "plan": {"type": "str", "default": "starter", "choices": PLANS},
            "status": {"type": "str", "default": "trial", "choices": ["active", "trial", "suspended"]},
            "currency_code": {"type": "str", "default": "USD", "max_len": 6},
            "currency_symbol": {"type": "str", "default": "$", "max_len": 4},
            "contact_email": {"type": "str", "default": "", "max_len": 180},
            "whatsapp_number": {"type": "str", "default": "", "max_len": 40},
            "owner_name": {"type": "str", "default": "", "max_len": 120},
            "owner_email": {"type": "email", "default": "", "max_len": 180},
            "owner_password": {"type": "text", "default": "", "trim": False, "max_len": 200},
        },
    )
    if payload["owner_email"]:
        if User.query.filter(db.func.lower(User.email) == payload["owner_email"].lower()).first():
            raise bad_request("That owner email is already registered.", {"owner_email": "Email already in use."})
        if len(payload["owner_password"]) < 8:
            raise bad_request("Set a password of at least 8 characters for the owner.",
                              {"owner_password": "Too short."})

    whatsapp_number = str(payload.get("whatsapp_number") or "").strip()
    if whatsapp_number:
        from app.services import whatsapp

        try:
            whatsapp_number = whatsapp.normalise_number(whatsapp_number)
        except ValueError as error:
            raise bad_request(str(error), {"whatsapp_number": str(error)}) from error

    company = provision_company(
        payload["name"],
        plan=payload["plan"],
        status=payload["status"],
        currency_code=payload["currency_code"],
        currency_symbol=payload["currency_symbol"],
        contact_email=payload["contact_email"],
        settings_patch={"business": {"whatsapp_number": whatsapp_number}},
    )
    owner = None
    if payload["owner_email"]:
        owner = add_user(
            company,
            email=payload["owner_email"],
            full_name=payload["owner_name"] or "Workspace Owner",
            password=payload["owner_password"],
            role=company.owner_role,
        )
    if whatsapp_number and owner is not None:
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
    audit("developer.company_created", entity="company", entity_id=company.id,
          summary=f"Created {company.name}", company_id=company.id, commit=True)
    return jsonify({"item": company.to_dict(detail=True)}), 201


@bp.get("/companies/<int:company_id>")
@developer_required
def get_company(company_id: int):
    company = get_scoped(Company, company_id)
    usage = {
        "sales": Sale.query.filter_by(company_id=company.id).count(),
        "products": Product.query.filter_by(company_id=company.id).count(),
        "customers": Customer.query.filter_by(company_id=company.id).count(),
        "users": User.query.filter_by(company_id=company.id).count(),
        "gross_cents": int(
            db.session.query(db.func.coalesce(db.func.sum(Sale.total_cents), 0))
            .filter(Sale.company_id == company.id)
            .scalar()
            or 0
        ),
    }
    return jsonify(
        {
            "item": company.to_dict(detail=True),
            "usage": usage,
            "users": [u.to_dict(include_company=False) for u in company.users],
            "roles": [r.to_dict() for r in company.roles],
        }
    )


@bp.patch("/companies/<int:company_id>")
@developer_required
def update_company(company_id: int):
    company = get_scoped(Company, company_id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "min_len": 2, "max_len": 120},
            "plan": {"type": "str", "choices": PLANS},
            "status": {"type": "str", "choices": ["active", "trial", "suspended"]},
            "contact_email": {"type": "str", "max_len": 180},
            "timezone": {"type": "str", "max_len": 64},
            "suspended_reason": {"type": "str", "max_len": 240},
            "trial_days": {"type": "int", "min": 0, "max": 365},
        },
    )
    if "trial_days" in payload:
        company.trial_ends_at = utcnow() + timedelta(days=payload.pop("trial_days"))
    for key, value in payload.items():
        setattr(company, key, value)
    db.session.commit()
    audit("developer.company_updated", entity="company", entity_id=company.id,
          summary=f"Updated {company.name}", company_id=company.id, commit=True)
    return jsonify({"item": company.to_dict(detail=True)})


@bp.post("/companies/<int:company_id>/modules")
@developer_required
def set_company_modules(company_id: int):
    company = get_scoped(Company, company_id)
    payload = validate(
        request.get_json(silent=True) or {},
        {"modules": {"type": "json", "required": True}},
    )
    modules = payload["modules"]
    if not isinstance(modules, dict):
        raise bad_request("Modules must be a map of key to enabled.")
    for key, enabled in modules.items():
        if key in {m["key"] for m in MODULE_CATALOG}:
            company.set_module(key, enabled=bool(enabled))
    db.session.commit()
    audit("developer.company_modules", entity="company", entity_id=company.id,
          summary="Adjusted modules for a company", company_id=company.id, commit=True)
    return jsonify({"modules": company.module_state})


@bp.delete("/companies/<int:company_id>")
@developer_required
def delete_company(company_id: int):
    company = get_scoped(Company, company_id)
    name = company.name
    purge_company(company)
    audit("developer.company_deleted", entity="company", entity_id=company_id,
          summary=f"Deleted {name} and all of its data", commit=True)
    return jsonify({"ok": True})


def purge_company(company: Company) -> None:
    """Delete a company and every record that belongs to it."""
    cid = company.id
    sale_ids = db.select(Sale.id).where(Sale.company_id == cid)
    refund_ids = db.select(Refund.id).where(Refund.company_id == cid)

    layby_ids = db.select(Layby.id).where(Layby.company_id == cid)
    db.session.execute(db.delete(LaybyPayment).where(LaybyPayment.layby_id.in_(layby_ids)))
    db.session.execute(db.delete(LaybyItem).where(LaybyItem.layby_id.in_(layby_ids)))
    db.session.execute(db.delete(Layby).where(Layby.company_id == cid))
    db.session.execute(db.delete(RefundItem).where(RefundItem.refund_id.in_(refund_ids)))
    db.session.execute(db.delete(Refund).where(Refund.company_id == cid))
    db.session.execute(db.delete(SalePayment).where(SalePayment.sale_id.in_(sale_ids)))
    db.session.execute(db.delete(SaleItem).where(SaleItem.sale_id.in_(sale_ids)))
    db.session.execute(db.delete(Sale).where(Sale.company_id == cid))

    for model in (
        WorkspaceRecord, CustomWorkspace, CustomField, HeldCart, Shift, StockMovement,
        Discount, Supplier, Customer, Product, TaxRate, PaymentMethod, Register, Location,
        AuditLog, CompanyModule, Role,
    ):
        db.session.execute(db.delete(model).where(model.company_id == cid))

    db.session.execute(db.delete(User).where(User.company_id == cid))
    db.session.expunge(company)
    db.session.execute(db.delete(Company).where(Company.id == cid))
    db.session.commit()


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #
@bp.get("/users")
@developer_required
def list_users():
    query = User.query.filter(User.is_developer.is_(False))
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(db.or_(User.full_name.ilike(like), User.email.ilike(like)))
    company_id = request.args.get("company_id", type=int)
    if company_id:
        query = query.filter(User.company_id == company_id)
    items, meta = paginate(query.order_by(User.created_at.desc()), default_per_page=30)
    return jsonify({"items": [u.to_dict() for u in items], "meta": meta})


@bp.patch("/users/<int:user_id>")
@developer_required
def update_user(user_id: int):
    user = get_scoped(User, user_id)
    if user.is_developer:
        raise bad_request("Developer accounts are managed outside the tenant console.")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "full_name": {"type": "str", "max_len": 120},
            "email": {"type": "email", "max_len": 180},
            "status": {"type": "str", "choices": ["active", "invited", "disabled"]},
            "role_id": {"type": "int"},
            "password": {"type": "text", "min_len": 8, "trim": False},
            "pin": {"type": "text", "max_len": 12, "trim": False},
        },
    )
    if "role_id" in payload and user.company_id:
        role = Role.query.filter_by(id=payload.pop("role_id"), company_id=user.company_id).first()
        if role is None:
            raise bad_request("That role does not belong to the user's company.")
        user.role_id = role.id
    elif "role_id" in payload:
        payload.pop("role_id")
    if "email" in payload:
        email = payload["email"].lower()
        clash = User.query.filter(db.func.lower(User.email) == email, User.id != user.id).first()
        if clash:
            raise bad_request("That email is already in use.", {"email": "Email already in use."})
        user.email = email
    for field in ("full_name", "status"):
        if field in payload:
            setattr(user, field, payload[field])
    if payload.get("password"):
        user.set_password(payload["password"])
    if "pin" in payload:
        user.set_pin(payload["pin"] or None)
    db.session.commit()
    audit("developer.user_updated", entity="user", entity_id=user.id,
          summary=f"Updated {user.email}", company_id=user.company_id, commit=True)
    return jsonify({"item": user.to_dict()})


@bp.delete("/users/<int:user_id>")
@developer_required
def delete_user(user_id: int):
    user = get_scoped(User, user_id)
    if user.is_developer:
        raise bad_request("Developer accounts cannot be deleted here.")
    if user.role and user.role.name == "Administrator" and user.company is not None:
        administrators = [u for u in user.company.users if u.role and u.role.name == "Administrator"]
        if len(administrators) <= 1:
            raise bad_request("A company needs at least one administrator. Appoint another admin first.")
    email = user.email
    Sale.query.filter_by(company_id=user.company_id, user_id=user.id).update({"user_id": None})
    db.session.delete(user)
    db.session.commit()
    audit("developer.user_deleted", entity="user", entity_id=user_id,
          summary=f"Deleted {email}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Audit, announcements and system
# --------------------------------------------------------------------------- #
@bp.get("/audit")
@developer_required
def platform_audit():
    query = AuditLog.query
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(
            db.or_(
                AuditLog.action.ilike(like),
                AuditLog.summary.ilike(like),
                AuditLog.actor_email.ilike(like),
            )
        )
    company_id = request.args.get("company_id", type=int)
    if company_id:
        query = query.filter(AuditLog.company_id == company_id)
    items, meta = paginate(query.order_by(AuditLog.created_at.desc()), default_per_page=40)
    companies = {c.id: c.name for c in Company.query.all()}
    payload = []
    for entry in items:
        data = entry.to_dict()
        data["company_name"] = companies.get(entry.company_id, "Platform")
        payload.append(data)
    return jsonify({"items": payload, "meta": meta})


@bp.get("/announcements")
@developer_required
def list_announcements():
    rows = Announcement.query.order_by(Announcement.created_at.desc()).all()
    companies = Company.query.order_by(Company.name).all()
    return jsonify(
        {
            "items": [a.to_dict() for a in rows],
            "companies": [{"id": c.id, "name": c.name} for c in companies],
        }
    )


@bp.post("/announcements")
@developer_required
def create_announcement():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "title": {"type": "str", "required": True, "max_len": 140, "label": "Title"},
            "body": {"type": "str", "default": "", "max_len": 4000},
            "level": {"type": "str", "default": "info", "choices": ["info", "warning", "critical"]},
            "audience": {"type": "str", "default": "all", "choices": ["all", "selected"]},
            "company_ids": {"type": "json", "default": []},
            "expires_in_days": {"type": "int", "default": 0, "min": 0, "max": 365},
        },
    )
    announcement = Announcement(
        title=payload["title"],
        body=payload["body"],
        level=payload["level"],
        audience=payload["audience"],
        company_ids=[int(c) for c in payload["company_ids"] if str(c).isdigit()],
        created_by="developer",
        expires_at=utcnow() + timedelta(days=payload["expires_in_days"]) if payload["expires_in_days"] else None,
    )
    db.session.add(announcement)
    db.session.commit()
    audit("developer.announcement_created", entity="announcement", entity_id=announcement.id,
          summary=f"Published '{announcement.title}'", commit=True)
    return jsonify({"item": announcement.to_dict()}), 201


@bp.patch("/announcements/<int:announcement_id>")
@developer_required
def update_announcement(announcement_id: int):
    announcement = get_scoped(Announcement, announcement_id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "title": {"type": "str", "max_len": 140},
            "body": {"type": "str", "max_len": 4000},
            "level": {"type": "str", "choices": ["info", "warning", "critical"]},
            "is_active": {"type": "bool"},
        },
    )
    for key, value in payload.items():
        setattr(announcement, key, value)
    db.session.commit()
    return jsonify({"item": announcement.to_dict()})


@bp.delete("/announcements/<int:announcement_id>")
@developer_required
def delete_announcement(announcement_id: int):
    announcement = get_scoped(Announcement, announcement_id)
    db.session.delete(announcement)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/system")
@developer_required
def system_info():
    retention = AuditLog.query.count()
    oldest = AuditLog.query.order_by(AuditLog.created_at.asc()).first()
    return jsonify(
        {
            "stats": _platform_stats(),
            "module_catalog": public_catalog(),
            "permissions": PERMISSIONS,
            "dashboard_widgets": DASHBOARD_WIDGETS,
            "database": {
                "audit_rows": retention,
                "oldest_audit": iso(oldest.created_at) if oldest else None,
            },
            "server_time": iso(utcnow()),
        }
    )


@bp.post("/system/prune-audit")
@developer_required
def prune_audit():
    days = (request.get_json(silent=True) or {}).get("days", 365)
    try:
        days = max(7, int(days))
    except (TypeError, ValueError):
        days = 365
    cutoff = utcnow() - timedelta(days=days)
    deleted = AuditLog.query.filter(AuditLog.created_at < cutoff).delete(synchronize_session=False)
    db.session.commit()
    return jsonify({"ok": True, "deleted": int(deleted)})
