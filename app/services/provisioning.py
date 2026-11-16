"""Workspace provisioning shared by self-service signup and the developer console."""

from __future__ import annotations

from datetime import timedelta

from app.defaults import DEFAULT_ROLES
from app.extensions import db
from app.models import Company, CompanyModule, Location, PaymentMethod, Register, Role, User
from app.modules import MODULE_CATALOG
from app.utils import slugify, unique_slug, utcnow


def provision_company(
    name: str,
    *,
    plan: str = "starter",
    status: str = "trial",
    currency_code: str = "USD",
    currency_symbol: str = "$",
    contact_email: str = "",
    timezone: str = "Africa/Harare",
    settings_patch: dict | None = None,
    trial_days: int = 14,
) -> Company:
    """Create a company with the default structure it needs to start selling."""
    company = Company(
        name=name.strip(),
        slug=unique_slug(Company, slugify(name)),
        status=status,
        plan=plan,
        contact_email=contact_email,
        timezone=timezone,
        trial_ends_at=utcnow() + timedelta(days=trial_days) if status == "trial" else None,
        settings_json={
            "currency": {
                "code": currency_code.upper()[:6],
                "symbol": currency_symbol or "$",
                "position": "before",
                "decimals": 2,
            },
            "business": {"legal_name": name.strip(), "email": contact_email},
            "branding": {"logo_text": name.strip()},
        },
    )
    db.session.add(company)
    db.session.flush()

    if settings_patch:
        company.update_settings(settings_patch)

    roles: dict[str, Role] = {}
    for spec in DEFAULT_ROLES:
        role = Role(
            company_id=company.id,
            name=spec["name"],
            description=spec["description"],
            permissions=list(spec["permissions"]),
            is_system=spec.get("system", False),
        )
        db.session.add(role)
        roles[role.name] = role

    location = Location(company_id=company.id, name="Main Store", code="MAIN", is_default=True)
    db.session.add(location)
    db.session.flush()
    db.session.add(Register(company_id=company.id, location_id=location.id, name="Counter 1", code="C1"))
    for method in (
        {"name": "Cash", "type": "cash", "icon": "cash", "opens_drawer": True, "sort_order": 10},
        {"name": "EcoCash", "type": "mobile", "icon": "phone", "requires_reference": True, "sort_order": 20},
        {"name": "Bank Transfer", "type": "bank", "icon": "bank", "requires_reference": True, "sort_order": 30},
        {"name": "Card", "type": "card", "icon": "card", "sort_order": 40},
    ):
        db.session.add(PaymentMethod(company_id=company.id, **method))

    for module in MODULE_CATALOG:
        db.session.add(
            CompanyModule(
                company_id=company.id,
                key=module["key"],
                enabled=bool(module.get("default")),
                config={},
                sort_order=100,
            )
        )

    db.session.flush()
    company.owner_role = roles.get("Owner")  # transient helper for callers
    return company


def add_user(company: Company, *, email: str, full_name: str, password: str,
             role: Role | None = None, status: str = "active", pin: str | None = None) -> User:
    user = User(
        company_id=company.id,
        role_id=role.id if role else None,
        email=email.lower(),
        full_name=full_name,
        status=status,
        avatar_color="#5b5bd6",
    )
    user.set_password(password)
    if pin:
        user.set_pin(pin)
    db.session.add(user)
    db.session.flush()
    return user
