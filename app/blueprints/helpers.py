"""Helpers shared by API blueprints."""

from __future__ import annotations

from app.extensions import db
from app.security import not_found


def get_scoped(model, object_id, company_id: int | None = None):
    """Fetch a row and enforce tenant ownership."""
    obj = db.session.get(model, object_id)
    if obj is None:
        not_found(f"{model.__name__} not found.")
    if company_id is not None:
        owner = getattr(obj, "company_id", None)
        if owner is not None and int(owner) != int(company_id):
            not_found(f"{model.__name__} not found.")
    return obj


def apply_fields(obj, clean: dict, *, aliases: dict[str, str] | None = None) -> None:
    aliases = aliases or {}
    for key, value in clean.items():
        setattr(obj, aliases.get(key, key), value)
