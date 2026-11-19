"""Idempotent schema top-ups for columns added after the first release.

``db.create_all()`` creates new tables but never alters existing ones, and the
project ships without a migration tool, so columns added later are applied here
on boot. Each entry is skipped when the column already exists.
"""

from sqlalchemy import inspect, text

from app.extensions import db

# (table, column, DDL type)
COLUMN_UPGRADES = (
    ("categories", "icon", "VARCHAR(40)"),
    ("users", "must_change_password", "BOOLEAN DEFAULT FALSE"),
    ("users", "whatsapp", "VARCHAR(40)"),
)


def ensure_columns(engine=None) -> list[str]:
    """Add any missing columns; returns the identifiers that were created."""
    engine = engine or db.engine
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    added: list[str] = []
    for table, column, ddl in COLUMN_UPGRADES:
        if table not in tables:
            continue
        if column in {row["name"] for row in inspector.get_columns(table)}:
            continue
        with engine.begin() as connection:
            connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        added.append(f"{table}.{column}")
    return added


def backfill_category_icons() -> int:
    """Give categories created before icons existed the look their products use."""
    from sqlalchemy import func

    from app.models import Category, Product

    updated = 0
    for category in Category.query.filter(Category.icon.is_(None)).all():
        common = (
            Product.query
            .filter(Product.company_id == category.company_id, Product.category_id == category.id)
            .with_entities(Product.icon, func.count(Product.id).label("uses"))
            .group_by(Product.icon)
            .order_by(func.count(Product.id).desc())
            .first()
        )
        category.icon = (common[0] if common and common[0] else "tag")
        updated += 1
    if updated:
        db.session.commit()
    return updated
