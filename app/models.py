"""Multi-tenant data model.

Every business record is owned by a :class:`Company`. Money is always stored as
an integer number of minor units (cents) to avoid floating point drift.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import UniqueConstraint

from app.defaults import deep_merge, default_preferences, default_settings
from app.extensions import db
from app.modules import MODULE_BY_KEY, module_defaults
from app.utils import initials, iso, utcnow


class TimestampMixin:
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class Base(db.Model):
    """Declarative base for every table.

    SQLAlchemy installs a ``**kwargs`` constructor on mapped classes at runtime, which
    type checkers cannot see. Declaring it here (mirroring
    ``sqlalchemy.orm.decl_base._declarative_constructor``) keeps ``Product(name=…)``
    and the rest type-checked without changing runtime behaviour.
    """

    __abstract__ = True

    def __init__(self, **kwargs: Any) -> None:
        cls = type(self)
        for key, value in kwargs.items():
            if not hasattr(cls, key):
                raise TypeError(f"{key!r} is an invalid keyword argument for {cls.__name__}")
            setattr(self, key, value)


# --------------------------------------------------------------------------- #
# Tenants
# --------------------------------------------------------------------------- #
class Company(TimestampMixin, Base):
    __tablename__ = "companies"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    slug = db.Column(db.String(64), unique=True, nullable=False, index=True)
    status = db.Column(db.String(20), default="active", nullable=False)  # active|trial|suspended
    plan = db.Column(db.String(40), default="unlimited", nullable=False)
    timezone = db.Column(db.String(64), default="UTC", nullable=False)
    contact_email = db.Column(db.String(180), default="")
    settings_json = db.Column(db.JSON, default=dict, nullable=False)
    trial_ends_at = db.Column(db.DateTime)
    suspended_reason = db.Column(db.String(240), default="")

    users = db.relationship("User", back_populates="company", cascade="all, delete-orphan")
    roles = db.relationship("Role", back_populates="company", cascade="all, delete-orphan")
    modules = db.relationship("CompanyModule", back_populates="company", cascade="all, delete-orphan")

    # ---- settings -------------------------------------------------------- #
    @property
    def settings(self) -> dict:
        return deep_merge(default_settings(), self.settings_json or {})

    def update_settings(self, patch: dict) -> dict:
        self.settings_json = deep_merge(self.settings_json or {}, patch)
        return self.settings

    @property
    def wordmark(self) -> str:
        """What the sidebar, receipts and browser title call this workspace.

        A wordmark typed in Branding wins; otherwise the workspace name follows
        every rename instead of leaving an old name on screen.
        """
        branding = (self.settings or {}).get("branding") or {}
        custom = " ".join(str(branding.get("logo_text") or "").split())
        if branding.get("logo_text_custom") and custom:
            return custom
        return (self.name or "").strip()

    # ---- modules --------------------------------------------------------- #
    @property
    def module_state(self) -> dict[str, dict]:
        state: dict[str, dict] = {}
        for row in self.modules:
            if row.key not in MODULE_BY_KEY:
                continue
            state[row.key] = {
                "key": row.key,
                "enabled": bool(row.enabled),
                "config": deep_merge(module_defaults(row.key), row.config or {}),
                "sort_order": row.sort_order,
            }
        for key, module in MODULE_BY_KEY.items():
            if key not in state:
                state[key] = {
                    "key": key,
                    "enabled": bool(module.get("default")),
                    "config": module_defaults(key),
                    "sort_order": 100,
                }
        return state

    def module_config(self, key: str) -> dict:
        row = next((m for m in self.modules if m.key == key), None)
        base = module_defaults(key)
        return deep_merge(base, (row.config if row and row.config else {}))

    def module_enabled(self, key: str) -> bool:
        row = next((m for m in self.modules if m.key == key), None)
        if row is not None:
            return bool(row.enabled)
        module = MODULE_BY_KEY.get(key)
        return bool(module and module.get("default"))

    def set_module(self, key: str, enabled: bool | None = None, config: dict | None = None) -> "CompanyModule":
        row = next((m for m in self.modules if m.key == key), None)
        if row is None:
            row = CompanyModule(company=self, key=key, enabled=bool(MODULE_BY_KEY.get(key, {}).get("default")))
            db.session.add(row)
            self.modules.append(row)
        if enabled is not None:
            row.enabled = bool(enabled)
        if config is not None:
            row.config = deep_merge(row.config or {}, config)
        return row

    @property
    def enabled_module_keys(self) -> list[str]:
        return [key for key, state in self.module_state.items() if state["enabled"]]

    # ---- serialisation --------------------------------------------------- #
    def to_dict(self, *, detail: bool = False) -> dict:
        payload = {
            "id": self.id,
            "name": self.name,
            "slug": self.slug,
            "status": self.status,
            "plan": self.plan,
            "timezone": self.timezone,
            "contact_email": self.contact_email,
            "trial_ends_at": iso(self.trial_ends_at),
            "suspended_reason": self.suspended_reason,
            "created_at": iso(self.created_at),
            "user_count": len(self.users),
        }
        if detail:
            payload["settings"] = self.settings
            payload["modules"] = self.module_state
        return payload

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Company {self.slug}>"


class CompanyModule(TimestampMixin, Base):
    __tablename__ = "company_modules"
    __table_args__ = (UniqueConstraint("company_id", "key", name="uq_company_module"),)

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    key = db.Column(db.String(60), nullable=False)
    enabled = db.Column(db.Boolean, default=True, nullable=False)
    config = db.Column(db.JSON, default=dict, nullable=False)
    sort_order = db.Column(db.Integer, default=100, nullable=False)

    company = db.relationship("Company", back_populates="modules")


class Role(TimestampMixin, Base):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("company_id", "name", name="uq_role_company_name"),)

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    name = db.Column(db.String(60), nullable=False)
    description = db.Column(db.String(200), default="")
    permissions = db.Column(db.JSON, default=list, nullable=False)
    is_system = db.Column(db.Boolean, default=False, nullable=False)

    company = db.relationship("Company", back_populates="roles")
    users = db.relationship("User", back_populates="role")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "permissions": list(self.permissions or []),
            "is_system": self.is_system,
            "user_count": len(self.users),
        }


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    role_id = db.Column(db.Integer, db.ForeignKey("roles.id", ondelete="SET NULL"))
    email = db.Column(db.String(180), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    full_name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(40), default="")
    whatsapp = db.Column(db.String(40), default="")
    status = db.Column(db.String(20), default="active", nullable=False)  # active|invited|disabled
    is_developer = db.Column(db.Boolean, default=False, nullable=False)
    must_change_password = db.Column(db.Boolean, default=False, nullable=False)
    pin_hash = db.Column(db.String(255))
    avatar_color = db.Column(db.String(20), default="#5b5bd6")
    last_login_at = db.Column(db.DateTime)
    failed_logins = db.Column(db.Integer, default=0, nullable=False)
    locked_until = db.Column(db.DateTime)

    company = db.relationship("Company", back_populates="users")
    role = db.relationship("Role", back_populates="users")
    preference = db.relationship(
        "UserPreference", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )

    # ---- personal preferences -------------------------------------------- #
    @property
    def preferences(self) -> dict:
        stored = (self.preference.data if self.preference else None) or {}
        return deep_merge(default_preferences(), stored)

    def update_preferences(self, patch: dict) -> dict:
        row = self.preference
        if row is None:
            row = UserPreference(user=self, data={})
            db.session.add(row)
            self.preference = row
        row.data = deep_merge(row.data or {}, patch)
        return self.preferences

    # ---- password / pin -------------------------------------------------- #
    def set_password(self, raw: str) -> None:
        from werkzeug.security import generate_password_hash

        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw: str) -> bool:
        from werkzeug.security import check_password_hash

        return bool(self.password_hash) and check_password_hash(self.password_hash, raw or "")

    def set_pin(self, raw: str | None) -> None:
        from werkzeug.security import generate_password_hash

        self.pin_hash = generate_password_hash(raw) if raw else None

    def check_pin(self, raw: str) -> bool:
        from werkzeug.security import check_password_hash

        return bool(self.pin_hash) and bool(raw) and check_password_hash(self.pin_hash, raw)

    # ---- authorisation --------------------------------------------------- #
    @property
    def permission_keys(self) -> set[str]:
        if self.is_developer:
            return {"*"}
        return set((self.role.permissions if self.role else []) or [])

    def has_permission(self, permission: str) -> bool:
        perms = self.permission_keys
        return "*" in perms or permission in perms

    def has_any(self, *permissions: str) -> bool:
        return any(self.has_permission(p) for p in permissions)

    @property
    def is_owner(self) -> bool:
        return bool(self.role and self.role.name in {"Administrator", "Owner"})

    @property
    def display_initial(self) -> str:
        return initials(self.full_name)

    def to_dict(self, *, include_company: bool = True) -> dict:
        payload = {
            "id": self.id,
            "email": self.email,
            "full_name": self.full_name,
            "phone": self.phone,
            "whatsapp": self.whatsapp or "",
            "status": self.status,
            "is_developer": self.is_developer,
            "pin_enabled": bool(self.pin_hash),
            "must_change_password": bool(self.must_change_password),
            "avatar_color": self.avatar_color,
            "initials": self.display_initial,
            "role_id": self.role_id,
            "role": self.role.name if self.role else None,
            "permissions": sorted(self.permission_keys),
            "last_login_at": iso(self.last_login_at),
            "created_at": iso(self.created_at),
        }
        if include_company:
            payload["company_id"] = self.company_id
            payload["company"] = self.company.name if self.company else "Platform"
            payload["company_slug"] = self.company.slug if self.company else None
        return payload

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email}>"


class UserPreference(Base):
    """Personal, per-user switches (theme, density, POS personal overrides).

    Stored in its own table so existing databases pick it up through
    ``db.create_all()`` without a column migration on ``users``.
    """

    __tablename__ = "user_preferences"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True
    )
    data = db.Column(db.JSON, default=dict, nullable=False)

    user = db.relationship("User", back_populates="preference")


class ReportRecipient(TimestampMixin, Base):
    """Someone who receives the executive summary but does not sign in.

    Deliberately separate from :class:`User`: a WhatsApp-only recipient needs no
    password, role or seat, and can be managed by an administrator alone.
    """

    __tablename__ = "report_recipients"
    __table_args__ = (
        UniqueConstraint("company_id", "whatsapp_number", name="uq_report_recipient_number"),
    )

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(
        db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), index=True)
    name = db.Column(db.String(120), nullable=False)
    whatsapp_number = db.Column(db.String(40), nullable=False)
    email = db.Column(db.String(180), default="")
    role_label = db.Column(db.String(80), default="")
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    last_sent_at = db.Column(db.DateTime)
    last_status = db.Column(db.String(20), default="")
    last_error = db.Column(db.String(240), default="")

    company = db.relationship("Company")
    user = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "whatsapp_number": self.whatsapp_number,
            "email": self.email or "",
            "role_label": self.role_label or "",
            "is_active": bool(self.is_active),
            "last_sent_at": iso(self.last_sent_at),
            "last_status": self.last_status or "",
            "last_error": self.last_error or "",
            "created_at": iso(self.created_at),
        }

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ReportRecipient {self.name} {self.whatsapp_number}>"


class ReportDispatch(TimestampMixin, Base):
    """One company/day delivery attempt, kept idempotent across retries."""

    __tablename__ = "report_dispatches"
    __table_args__ = (
        UniqueConstraint("company_id", "report_date", "channel", name="uq_report_dispatch_day"),
    )

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(
        db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    report_date = db.Column(db.Date, nullable=False)
    channel = db.Column(db.String(20), default="whatsapp", nullable=False)
    status = db.Column(db.String(20), default="sending", nullable=False)
    recipient_count = db.Column(db.Integer, default=0, nullable=False)
    delivered_count = db.Column(db.Integer, default=0, nullable=False)
    failed_count = db.Column(db.Integer, default=0, nullable=False)
    summary = db.Column(db.Text, default="")
    details = db.Column(db.JSON, default=list, nullable=False)
    sent_at = db.Column(db.DateTime)

    company = db.relationship("Company")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "report_date": self.report_date.isoformat() if self.report_date else "",
            "channel": self.channel,
            "status": self.status,
            "recipient_count": self.recipient_count,
            "delivered_count": self.delivered_count,
            "failed_count": self.failed_count,
            "summary": self.summary or "",
            "details": self.details or [],
            "sent_at": iso(self.sent_at),
            "updated_at": iso(self.updated_at),
        }


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
class Location(TimestampMixin, Base):
    __tablename__ = "locations"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(120), nullable=False)
    code = db.Column(db.String(20), default="")
    address = db.Column(db.String(240), default="")
    phone = db.Column(db.String(40), default="")
    is_default = db.Column(db.Boolean, default=False, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    registers = db.relationship("Register", back_populates="location", cascade="all, delete-orphan")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "code": self.code,
            "address": self.address,
            "phone": self.phone,
            "is_default": self.is_default,
            "is_active": self.is_active,
            "register_count": len(self.registers),
        }


class Register(TimestampMixin, Base):
    __tablename__ = "registers"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    location_id = db.Column(db.Integer, db.ForeignKey("locations.id", ondelete="CASCADE"))
    name = db.Column(db.String(80), nullable=False)
    code = db.Column(db.String(20), default="")
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    location = db.relationship("Location", back_populates="registers")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "code": self.code,
            "location_id": self.location_id,
            "location": self.location.name if self.location else None,
            "is_active": self.is_active,
        }


class TaxRate(TimestampMixin, Base):
    __tablename__ = "tax_rates"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(60), nullable=False)
    rate = db.Column(db.Float, default=0.0, nullable=False)  # percentage, e.g. 15.5
    is_default = db.Column(db.Boolean, default=False, nullable=False)
    is_inclusive = db.Column(db.Boolean, default=False, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "rate": round(self.rate or 0, 4),
            "is_default": self.is_default,
            "is_inclusive": self.is_inclusive,
            "is_active": self.is_active,
        }


class PaymentMethod(TimestampMixin, Base):
    __tablename__ = "payment_methods"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(60), nullable=False)
    type = db.Column(db.String(20), default="cash", nullable=False)  # cash|card|mobile|bank|credit|other
    icon = db.Column(db.String(40), default="cash")
    requires_reference = db.Column(db.Boolean, default=False, nullable=False)
    opens_drawer = db.Column(db.Boolean, default=False, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    sort_order = db.Column(db.Integer, default=100, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "icon": self.icon,
            "requires_reference": self.requires_reference,
            "opens_drawer": self.opens_drawer,
            "is_active": self.is_active,
            "sort_order": self.sort_order,
        }


class CustomField(TimestampMixin, Base):
    __tablename__ = "custom_fields"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    entity = db.Column(db.String(20), nullable=False)  # product|customer
    key = db.Column(db.String(60), nullable=False)
    label = db.Column(db.String(80), nullable=False)
    type = db.Column(db.String(20), default="text", nullable=False)  # text|number|select|date|bool|textarea
    options = db.Column(db.JSON, default=list)
    required = db.Column(db.Boolean, default=False, nullable=False)
    sort_order = db.Column(db.Integer, default=100, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "entity": self.entity,
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "options": list(self.options or []),
            "required": self.required,
            "sort_order": self.sort_order,
        }


# --------------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------------- #
class Department(TimestampMixin, Base):
    __tablename__ = "departments"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(90), nullable=False)
    description = db.Column(db.String(240), default="")
    color = db.Column(db.String(20), default="#5b5bd6")
    icon = db.Column(db.String(40), default="layers")
    sort_order = db.Column(db.Integer, default=100, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    categories = db.relationship("Category", back_populates="department", order_by="Category.sort_order")
    products = db.relationship("Product", back_populates="department")

    def to_dict(self) -> dict:
        product_ids = {product.id for product in self.products}
        for category in self.categories:
            product_ids.update(product.id for product in category.products)
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "color": self.color,
            "icon": self.icon,
            "sort_order": self.sort_order,
            "is_active": self.is_active,
            "category_count": len(self.categories),
            "product_count": len(product_ids),
            "categories": [category.to_dict() for category in self.categories],
        }


class Category(TimestampMixin, Base):
    __tablename__ = "categories"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    department_id = db.Column(db.Integer, db.ForeignKey("departments.id", ondelete="SET NULL"), index=True)
    name = db.Column(db.String(80), nullable=False)
    color = db.Column(db.String(20), default="#5b5bd6")
    icon = db.Column(db.String(40), default="tag")
    sort_order = db.Column(db.Integer, default=100, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    products = db.relationship("Product", back_populates="category")
    department = db.relationship("Department", back_populates="categories")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "icon": self.icon or "tag",
            "department_id": self.department_id,
            "department": self.department.name if self.department else None,
            "sort_order": self.sort_order,
            "is_active": self.is_active,
            "product_count": len(self.products),
        }


class Product(TimestampMixin, Base):
    __tablename__ = "products"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    department_id = db.Column(db.Integer, db.ForeignKey("departments.id", ondelete="SET NULL"), index=True)
    category_id = db.Column(db.Integer, db.ForeignKey("categories.id", ondelete="SET NULL"), index=True)
    tax_rate_id = db.Column(db.Integer, db.ForeignKey("tax_rates.id", ondelete="SET NULL"))
    name = db.Column(db.String(160), nullable=False)
    sku = db.Column(db.String(60), default="", index=True)
    barcode = db.Column(db.String(60), default="", index=True)
    description = db.Column(db.Text, default="")
    price_cents = db.Column(db.Integer, default=0, nullable=False)
    cost_cents = db.Column(db.Integer, default=0, nullable=False)
    unit = db.Column(db.String(20), default="unit")
    track_stock = db.Column(db.Boolean, default=True, nullable=False)
    stock_qty = db.Column(db.Float, default=0.0, nullable=False)
    low_stock_threshold = db.Column(db.Integer, default=5, nullable=False)
    color = db.Column(db.String(20), default="#5b5bd6")
    image = db.Column(db.String(255), default="")
    icon = db.Column(db.String(40), default="box")
    emoji = db.Column(db.String(8), default="")
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    is_featured = db.Column(db.Boolean, default=False, nullable=False)
    custom_fields = db.Column(db.JSON, default=dict, nullable=False)

    category = db.relationship("Category", back_populates="products")
    department = db.relationship("Department", back_populates="products")
    tax_rate = db.relationship("TaxRate")

    @property
    def is_low_stock(self) -> bool:
        return self.track_stock and self.stock_qty <= (self.low_stock_threshold or 0)

    @property
    def margin_percent(self) -> float:
        if not self.price_cents:
            return 0.0
        return round(((self.price_cents - self.cost_cents) / self.price_cents) * 100, 1)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "sku": self.sku,
            "barcode": self.barcode,
            "description": self.description,
            "category_id": self.category_id,
            "category": self.category.name if self.category else None,
            "category_color": self.category.color if self.category else "#5b5bd6",
            "department_id": self.department_id or (self.category.department_id if self.category else None),
            "department": (
                self.department.name if self.department
                else (self.category.department.name if self.category and self.category.department else None)
            ),
            "tax_rate_id": self.tax_rate_id,
            "tax_rate": self.tax_rate.to_dict() if self.tax_rate else None,
            "price_cents": self.price_cents,
            "cost_cents": self.cost_cents,
            "unit": self.unit,
            "track_stock": self.track_stock,
            "stock_qty": round(self.stock_qty or 0, 3),
            "low_stock_threshold": self.low_stock_threshold,
            "is_low_stock": self.is_low_stock,
            "color": self.color,
            "image": self.image,
            "icon": self.icon or "box",
            "emoji": self.emoji,
            "is_active": self.is_active,
            "is_featured": self.is_featured,
            "custom_fields": self.custom_fields or {},
            "margin_percent": self.margin_percent,
            "created_at": iso(self.created_at),
        }


class StockMovement(Base):
    __tablename__ = "stock_movements"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("suppliers.id", ondelete="SET NULL"))
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    qty_delta = db.Column(db.Float, default=0.0, nullable=False)
    balance_after = db.Column(db.Float, default=0.0, nullable=False)
    reason = db.Column(db.String(40), default="adjustment", nullable=False)
    reference = db.Column(db.String(80), default="")
    note = db.Column(db.String(240), default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    product = db.relationship("Product")
    supplier = db.relationship("Supplier")
    user = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "product": self.product.name if self.product else "Deleted product",
            "sku": self.product.sku if self.product else "",
            "qty_delta": round(self.qty_delta or 0, 3),
            "balance_after": round(self.balance_after or 0, 3),
            "reason": self.reason,
            "reference": self.reference,
            "note": self.note,
            "supplier": self.supplier.name if self.supplier else None,
            "user": self.user.full_name if self.user else "System",
            "created_at": iso(self.created_at),
        }


class StockFunding(Base):
    """Where the money for a batch of stock came from.

    ``source`` is ``profit`` (cash generated by sales) or ``external`` (owner
    capital, a loan, an investor). Each purchase keeps its own row so the shop
    can see how much of the shelf was funded by trading and how much came from
    outside the business.
    """

    __tablename__ = "stock_fundings"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(
        db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id = db.Column(
        db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    movement_id = db.Column(
        db.Integer, db.ForeignKey("stock_movements.id", ondelete="CASCADE"), index=True
    )
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    source = db.Column(db.String(16), default="profit", nullable=False)
    amount_cents = db.Column(db.Integer, default=0, nullable=False)
    note = db.Column(db.String(160), default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    product = db.relationship("Product")
    movement = db.relationship("StockMovement")
    user = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "product": self.product.name if self.product else "Deleted product",
            "movement_id": self.movement_id,
            "source": self.source,
            "label": "Profits from sales" if self.source == "profit" else "External funds",
            "amount_cents": int(self.amount_cents or 0),
            "note": self.note,
            "user": self.user.full_name if self.user else "System",
            "created_at": iso(self.created_at),
        }


class StockLayer(Base):
    """One FIFO cost layer: stock received at a known buying price.

    Sales consume the oldest layers first, so cost of goods sold (and therefore
    profit) reflects what the goods actually cost when they were bought.
    """

    __tablename__ = "stock_layers"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(
        db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id = db.Column(
        db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    received_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)
    qty_received = db.Column(db.Float, default=0.0, nullable=False)
    qty_remaining = db.Column(db.Float, default=0.0, nullable=False)
    unit_cost_cents = db.Column(db.Integer, default=0, nullable=False)
    source = db.Column(db.String(30), default="receive", nullable=False)
    reference = db.Column(db.String(80), default="")

    product = db.relationship("Product")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "received_at": iso(self.received_at),
            "qty_received": round(self.qty_received or 0, 3),
            "qty_remaining": round(self.qty_remaining or 0, 3),
            "unit_cost_cents": int(self.unit_cost_cents or 0),
            "source": self.source,
            "reference": self.reference,
        }


class Supplier(TimestampMixin, Base):
    __tablename__ = "suppliers"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(120), nullable=False)
    contact_name = db.Column(db.String(120), default="")
    email = db.Column(db.String(180), default="")
    phone = db.Column(db.String(40), default="")
    address = db.Column(db.String(240), default="")
    notes = db.Column(db.Text, default="")
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "contact_name": self.contact_name,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "notes": self.notes,
            "is_active": self.is_active,
        }


class Customer(TimestampMixin, Base):
    __tablename__ = "customers"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(180), default="", index=True)
    phone = db.Column(db.String(40), default="", index=True)
    address = db.Column(db.String(240), default="")
    tax_number = db.Column(db.String(60), default="")
    notes = db.Column(db.Text, default="")
    loyalty_points = db.Column(db.Integer, default=0, nullable=False)
    credit_balance_cents = db.Column(db.Integer, default=0, nullable=False)
    credit_limit_cents = db.Column(db.Integer, default=0, nullable=False)
    total_spent_cents = db.Column(db.Integer, default=0, nullable=False)
    visits = db.Column(db.Integer, default=0, nullable=False)
    last_visit_at = db.Column(db.DateTime)
    custom_fields = db.Column(db.JSON, default=dict, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "address": self.address,
            "tax_number": self.tax_number,
            "notes": self.notes,
            "loyalty_points": self.loyalty_points,
            "credit_balance_cents": self.credit_balance_cents,
            "credit_limit_cents": self.credit_limit_cents,
            "total_spent_cents": self.total_spent_cents,
            "visits": self.visits,
            "last_visit_at": iso(self.last_visit_at),
            "custom_fields": self.custom_fields or {},
            "is_active": self.is_active,
            "created_at": iso(self.created_at),
        }


class Discount(TimestampMixin, Base):
    __tablename__ = "discounts"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(120), nullable=False)
    code = db.Column(db.String(40), default="", index=True)
    type = db.Column(db.String(20), default="percent", nullable=False)  # percent|fixed
    value = db.Column(db.Float, default=0.0, nullable=False)  # percent points or major units
    min_subtotal_cents = db.Column(db.Integer, default=0, nullable=False)
    max_uses = db.Column(db.Integer, default=0, nullable=False)  # 0 = unlimited
    uses = db.Column(db.Integer, default=0, nullable=False)
    starts_at = db.Column(db.DateTime)
    ends_at = db.Column(db.DateTime)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    @property
    def amount_cents_for(self) -> int:
        return int(round((self.value or 0) * 100))

    def is_valid_now(self) -> bool:
        now = utcnow()
        if not self.is_active:
            return False
        if self.max_uses and self.uses >= self.max_uses:
            return False
        if self.starts_at and self.starts_at > now:
            return False
        if self.ends_at and self.ends_at < now:
            return False
        return True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "code": self.code,
            "type": self.type,
            "value": self.value,
            "min_subtotal_cents": self.min_subtotal_cents,
            "max_uses": self.max_uses,
            "uses": self.uses,
            "starts_at": iso(self.starts_at),
            "ends_at": iso(self.ends_at),
            "is_active": self.is_active,
            "is_valid": self.is_valid_now(),
        }


# --------------------------------------------------------------------------- #
# Selling
# --------------------------------------------------------------------------- #
class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (UniqueConstraint("company_id", "number", name="uq_sale_number"),)

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    location_id = db.Column(db.Integer, db.ForeignKey("locations.id", ondelete="SET NULL"))
    register_id = db.Column(db.Integer, db.ForeignKey("registers.id", ondelete="SET NULL"))
    shift_id = db.Column(db.Integer, db.ForeignKey("shifts.id", ondelete="SET NULL"), index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), index=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="SET NULL"), index=True)
    discount_id = db.Column(db.Integer, db.ForeignKey("discounts.id", ondelete="SET NULL"))

    number = db.Column(db.String(40), nullable=False, index=True)
    status = db.Column(db.String(20), default="completed", nullable=False, index=True)
    # completed | refunded | partially_refunded | voided

    subtotal_cents = db.Column(db.Integer, default=0, nullable=False)
    discount_cents = db.Column(db.Integer, default=0, nullable=False)
    tax_cents = db.Column(db.Integer, default=0, nullable=False)
    service_charge_cents = db.Column(db.Integer, default=0, nullable=False)
    tip_cents = db.Column(db.Integer, default=0, nullable=False)
    rounding_cents = db.Column(db.Integer, default=0, nullable=False)
    total_cents = db.Column(db.Integer, default=0, nullable=False)
    paid_cents = db.Column(db.Integer, default=0, nullable=False)
    change_cents = db.Column(db.Integer, default=0, nullable=False)
    refunded_cents = db.Column(db.Integer, default=0, nullable=False)
    cost_cents = db.Column(db.Integer, default=0, nullable=False)

    note = db.Column(db.Text, default="")
    discount_label = db.Column(db.String(120), default="")
    loyalty_points_earned = db.Column(db.Integer, default=0, nullable=False)
    loyalty_points_redeemed = db.Column(db.Integer, default=0, nullable=False)
    source = db.Column(db.String(20), default="pos", nullable=False)
    custom_fields = db.Column(db.JSON, default=dict, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    company = db.relationship("Company")
    user = db.relationship("User")
    customer = db.relationship("Customer")
    location = db.relationship("Location")
    register = db.relationship("Register")
    discount = db.relationship("Discount")
    items = db.relationship("SaleItem", back_populates="sale", cascade="all, delete-orphan")
    payments = db.relationship("SalePayment", back_populates="sale", cascade="all, delete-orphan")
    refunds = db.relationship("Refund", back_populates="sale", cascade="all, delete-orphan")

    @property
    def item_count(self) -> float:
        return round(sum(i.qty for i in self.items), 3)

    def to_dict(self, *, detail: bool = False) -> dict:
        payload = {
            "id": self.id,
            "number": self.number,
            "status": self.status,
            "subtotal_cents": self.subtotal_cents,
            "discount_cents": self.discount_cents,
            "tax_cents": self.tax_cents,
            "service_charge_cents": self.service_charge_cents,
            "tip_cents": self.tip_cents,
            "rounding_cents": self.rounding_cents,
            "total_cents": self.total_cents,
            "paid_cents": self.paid_cents,
            "change_cents": self.change_cents,
            "refunded_cents": self.refunded_cents,
            "cost_cents": self.cost_cents,
            "profit_cents": (self.total_cents or 0) - (self.refunded_cents or 0) - (self.cost_cents or 0),
            "note": self.note,
            "discount_label": self.discount_label,
            "loyalty_points_earned": self.loyalty_points_earned,
            "loyalty_points_redeemed": self.loyalty_points_redeemed,
            "source": self.source,
            "item_count": self.item_count,
            "customer_id": self.customer_id,
            "customer": self.customer.name if self.customer else "Walk-in",
            "cashier": self.user.full_name if self.user else "Deleted user",
            "cashier_id": self.user_id,
            "location": self.location.name if self.location else None,
            "register": self.register.name if self.register else None,
            "created_at": iso(self.created_at),
            "payment_methods": sorted({p.method_name for p in self.payments}),
        }
        if detail:
            payload["items"] = [i.to_dict() for i in self.items]
            payload["payments"] = [p.to_dict() for p in self.payments]
            payload["refunds"] = [r.to_dict() for r in self.refunds]
        return payload


class SaleItem(Base):
    __tablename__ = "sale_items"

    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="SET NULL"))
    name = db.Column(db.String(160), nullable=False)
    sku = db.Column(db.String(60), default="")
    qty = db.Column(db.Float, default=1.0, nullable=False)
    unit_price_cents = db.Column(db.Integer, default=0, nullable=False)
    discount_cents = db.Column(db.Integer, default=0, nullable=False)
    tax_rate_percent = db.Column(db.Float, default=0.0, nullable=False)
    tax_cents = db.Column(db.Integer, default=0, nullable=False)
    line_subtotal_cents = db.Column(db.Integer, default=0, nullable=False)
    line_total_cents = db.Column(db.Integer, default=0, nullable=False)
    cost_cents = db.Column(db.Integer, default=0, nullable=False)
    note = db.Column(db.String(240), default="")
    refunded_qty = db.Column(db.Float, default=0.0, nullable=False)

    sale = db.relationship("Sale", back_populates="items")
    product = db.relationship("Product")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "name": self.name,
            "sku": self.sku,
            "qty": round(self.qty or 0, 3),
            "unit_price_cents": self.unit_price_cents,
            "discount_cents": self.discount_cents,
            "tax_rate_percent": round(self.tax_rate_percent or 0, 4),
            "tax_cents": self.tax_cents,
            "line_subtotal_cents": self.line_subtotal_cents,
            "line_total_cents": self.line_total_cents,
            "note": self.note,
            "refunded_qty": round(self.refunded_qty or 0, 3),
        }


class SalePayment(Base):
    __tablename__ = "sale_payments"

    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="CASCADE"), nullable=False, index=True)
    method_id = db.Column(db.Integer, db.ForeignKey("payment_methods.id", ondelete="SET NULL"))
    method_name = db.Column(db.String(60), nullable=False)
    method_type = db.Column(db.String(20), default="cash", nullable=False)
    amount_cents = db.Column(db.Integer, default=0, nullable=False)
    tendered_cents = db.Column(db.Integer, default=0, nullable=False)
    change_cents = db.Column(db.Integer, default=0, nullable=False)
    reference = db.Column(db.String(120), default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    sale = db.relationship("Sale", back_populates="payments")
    method = db.relationship("PaymentMethod")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "method_id": self.method_id,
            "method_name": self.method_name,
            "method_type": self.method_type,
            "amount_cents": self.amount_cents,
            "tendered_cents": self.tendered_cents,
            "change_cents": self.change_cents,
            "reference": self.reference,
            "opens_drawer": bool(self.method.opens_drawer) if self.method else False,
        }


class Refund(Base):
    __tablename__ = "refunds"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    amount_cents = db.Column(db.Integer, default=0, nullable=False)
    method = db.Column(db.String(30), default="original", nullable=False)  # original|cash|store_credit
    reason = db.Column(db.String(240), default="")
    restock = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    sale = db.relationship("Sale", back_populates="refunds")
    user = db.relationship("User")
    items = db.relationship("RefundItem", back_populates="refund", cascade="all, delete-orphan")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sale_id": self.sale_id,
            "amount_cents": self.amount_cents,
            "method": self.method,
            "reason": self.reason,
            "restock": self.restock,
            "user": self.user.full_name if self.user else "System",
            "created_at": iso(self.created_at),
            "items": [i.to_dict() for i in self.items],
        }


class RefundItem(Base):
    __tablename__ = "refund_items"

    id = db.Column(db.Integer, primary_key=True)
    refund_id = db.Column(db.Integer, db.ForeignKey("refunds.id", ondelete="CASCADE"), nullable=False, index=True)
    sale_item_id = db.Column(db.Integer, db.ForeignKey("sale_items.id", ondelete="CASCADE"), nullable=False)
    qty = db.Column(db.Float, default=0.0, nullable=False)
    amount_cents = db.Column(db.Integer, default=0, nullable=False)

    refund = db.relationship("Refund", back_populates="items")
    sale_item = db.relationship("SaleItem")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sale_item_id": self.sale_item_id,
            "name": self.sale_item.name if self.sale_item else "",
            "qty": round(self.qty or 0, 3),
            "amount_cents": self.amount_cents,
        }


class HeldCart(TimestampMixin, Base):
    __tablename__ = "held_carts"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    name = db.Column(db.String(120), default="Held order")
    payload = db.Column(db.JSON, default=dict, nullable=False)

    user = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "payload": self.payload or {},
            "user": self.user.full_name if self.user else "Staff",
            "created_at": iso(self.created_at),
        }


class Layby(TimestampMixin, Base):
    """Lay-by / layaway: deposit now, pay the balance over time."""

    __tablename__ = "laybys"
    __table_args__ = (UniqueConstraint("company_id", "number", name="uq_layby_number"),)

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id", ondelete="SET NULL"), index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="SET NULL"))

    number = db.Column(db.String(40), nullable=False, index=True)
    status = db.Column(db.String(20), default="active", nullable=False, index=True)  # active|completed|cancelled
    total_cents = db.Column(db.Integer, default=0, nullable=False)
    deposit_cents = db.Column(db.Integer, default=0, nullable=False)
    paid_cents = db.Column(db.Integer, default=0, nullable=False)
    forfeited_cents = db.Column(db.Integer, default=0, nullable=False)
    due_date = db.Column(db.DateTime)
    completed_at = db.Column(db.DateTime)
    cancelled_at = db.Column(db.DateTime)
    note = db.Column(db.Text, default="")
    cancellation_reason = db.Column(db.String(240), default="")

    customer = db.relationship("Customer")
    user = db.relationship("User")
    sale = db.relationship("Sale")
    items = db.relationship("LaybyItem", back_populates="layby", cascade="all, delete-orphan")
    payments = db.relationship(
        "LaybyPayment", back_populates="layby", cascade="all, delete-orphan",
        order_by="LaybyPayment.created_at",
    )

    @property
    def balance_cents(self) -> int:
        return max(0, (self.total_cents or 0) - (self.paid_cents or 0))

    @property
    def is_overdue(self) -> bool:
        return bool(self.status == "active" and self.due_date and self.due_date < utcnow())

    def to_dict(self, *, detail: bool = False) -> dict:
        payload = {
            "id": self.id,
            "number": self.number,
            "status": self.status,
            "total_cents": self.total_cents,
            "deposit_cents": self.deposit_cents,
            "paid_cents": self.paid_cents,
            "balance_cents": self.balance_cents,
            "forfeited_cents": self.forfeited_cents,
            "is_overdue": self.is_overdue,
            "due_date": iso(self.due_date),
            "completed_at": iso(self.completed_at),
            "cancelled_at": iso(self.cancelled_at),
            "note": self.note,
            "cancellation_reason": self.cancellation_reason,
            "customer_id": self.customer_id,
            "customer": self.customer.name if self.customer else "Walk-in",
            "cashier": self.user.full_name if self.user else "—",
            "sale_id": self.sale_id,
            "sale_number": self.sale.number if self.sale else None,
            "item_count": len(self.items),
            "created_at": iso(self.created_at),
            "updated_at": iso(self.updated_at),
        }
        if detail:
            payload["items"] = [item.to_dict() for item in self.items]
            payload["payments"] = [payment.to_dict() for payment in self.payments]
        return payload


class LaybyItem(Base):
    __tablename__ = "layby_items"

    id = db.Column(db.Integer, primary_key=True)
    layby_id = db.Column(db.Integer, db.ForeignKey("laybys.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="SET NULL"))
    name = db.Column(db.String(160), nullable=False)
    sku = db.Column(db.String(60), default="")
    qty = db.Column(db.Float, default=1.0, nullable=False)
    unit_price_cents = db.Column(db.Integer, default=0, nullable=False)
    line_total_cents = db.Column(db.Integer, default=0, nullable=False)

    layby = db.relationship("Layby", back_populates="items")
    product = db.relationship("Product")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "product_id": self.product_id,
            "name": self.name,
            "sku": self.sku,
            "qty": round(self.qty or 0, 3),
            "unit_price_cents": self.unit_price_cents,
            "line_total_cents": self.line_total_cents,
        }


class LaybyPayment(Base):
    __tablename__ = "layby_payments"

    id = db.Column(db.Integer, primary_key=True)
    layby_id = db.Column(db.Integer, db.ForeignKey("laybys.id", ondelete="CASCADE"), nullable=False, index=True)
    method_id = db.Column(db.Integer, db.ForeignKey("payment_methods.id", ondelete="SET NULL"))
    method_name = db.Column(db.String(60), default="Cash", nullable=False)
    method_type = db.Column(db.String(20), default="cash", nullable=False)
    amount_cents = db.Column(db.Integer, default=0, nullable=False)
    reference = db.Column(db.String(120), default="")
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    layby = db.relationship("Layby", back_populates="payments")
    user = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "method_name": self.method_name,
            "method_type": self.method_type,
            "amount_cents": self.amount_cents,
            "reference": self.reference,
            "cashier": self.user.full_name if self.user else "—",
            "created_at": iso(self.created_at),
        }


class Shift(Base):
    __tablename__ = "shifts"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), index=True)
    register_id = db.Column(db.Integer, db.ForeignKey("registers.id", ondelete="SET NULL"))
    status = db.Column(db.String(20), default="open", nullable=False, index=True)
    opening_float_cents = db.Column(db.Integer, default=0, nullable=False)
    counted_cash_cents = db.Column(db.Integer, default=0, nullable=False)
    expected_cash_cents = db.Column(db.Integer, default=0, nullable=False)
    variance_cents = db.Column(db.Integer, default=0, nullable=False)
    sales_cents = db.Column(db.Integer, default=0, nullable=False)
    refunds_cents = db.Column(db.Integer, default=0, nullable=False)
    notes = db.Column(db.Text, default="")
    opened_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)
    closed_at = db.Column(db.DateTime)

    user = db.relationship("User")
    register = db.relationship("Register")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "opening_float_cents": self.opening_float_cents,
            "counted_cash_cents": self.counted_cash_cents,
            "expected_cash_cents": self.expected_cash_cents,
            "variance_cents": self.variance_cents,
            "sales_cents": self.sales_cents,
            "refunds_cents": self.refunds_cents,
            "notes": self.notes,
            "user": self.user.full_name if self.user else "Deleted user",
            "user_id": self.user_id,
            "register": self.register.name if self.register else None,
            "opened_at": iso(self.opened_at),
            "closed_at": iso(self.closed_at),
        }


# --------------------------------------------------------------------------- #
# Governance
# --------------------------------------------------------------------------- #
class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))
    actor_email = db.Column(db.String(180), default="")
    actor_name = db.Column(db.String(120), default="")
    action = db.Column(db.String(80), nullable=False, index=True)
    entity = db.Column(db.String(60), default="")
    entity_id = db.Column(db.String(40), default="")
    summary = db.Column(db.String(240), default="")
    meta = db.Column(db.JSON, default=dict)
    ip = db.Column(db.String(60), default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "company_id": self.company_id,
            "action": self.action,
            "entity": self.entity,
            "entity_id": self.entity_id,
            "summary": self.summary,
            "meta": self.meta or {},
            "actor": self.actor_name or self.actor_email or "System",
            "actor_email": self.actor_email,
            "ip": self.ip,
            "created_at": iso(self.created_at),
        }


class Announcement(TimestampMixin, Base):
    __tablename__ = "announcements"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(140), nullable=False)
    body = db.Column(db.Text, default="")
    level = db.Column(db.String(20), default="info", nullable=False)  # info|warning|critical
    audience = db.Column(db.String(20), default="all", nullable=False)  # all|selected
    company_ids = db.Column(db.JSON, default=list)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_by = db.Column(db.String(180), default="")
    expires_at = db.Column(db.DateTime)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "body": self.body,
            "level": self.level,
            "audience": self.audience,
            "company_ids": list(self.company_ids or []),
            "is_active": self.is_active,
            "created_by": self.created_by,
            "expires_at": iso(self.expires_at),
            "created_at": iso(self.created_at),
        }


# --------------------------------------------------------------------------- #
# Company authored features
# --------------------------------------------------------------------------- #
class CustomWorkspace(TimestampMixin, Base):
    __tablename__ = "custom_workspaces"

    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    name = db.Column(db.String(80), nullable=False)
    icon = db.Column(db.String(40), default="sparkles")
    description = db.Column(db.String(240), default="")
    fields = db.Column(db.JSON, default=list, nullable=False)
    sort_order = db.Column(db.Integer, default=100, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)

    records = db.relationship("WorkspaceRecord", back_populates="workspace", cascade="all, delete-orphan")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "icon": self.icon,
            "description": self.description,
            "fields": list(self.fields or []),
            "sort_order": self.sort_order,
            "is_active": self.is_active,
            "record_count": len(self.records),
        }


class WorkspaceRecord(TimestampMixin, Base):
    __tablename__ = "workspace_records"

    id = db.Column(db.Integer, primary_key=True)
    workspace_id = db.Column(db.Integer, db.ForeignKey("custom_workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id = db.Column(db.Integer, db.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    company = db.relationship("Company")
    data = db.Column(db.JSON, default=dict, nullable=False)
    created_by = db.Column(db.String(120), default="")

    workspace = db.relationship("CustomWorkspace", back_populates="records")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "data": self.data or {},
            "created_by": self.created_by,
            "created_at": iso(self.created_at),
            "updated_at": iso(self.updated_at),
        }


def retention_cutoff(days: int):
    return utcnow() - timedelta(days=max(1, days))
