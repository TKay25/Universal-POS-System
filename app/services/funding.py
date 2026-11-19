"""Stock funding: was the shelf paid for with trading profit or outside money?

Every stock purchase can record one of two sources:

* ``profit``   — cash the shop generated from sales.
* ``external`` — owner capital, a loan, an investor or family money.

The split lets a manager answer "has this business funded its own stock yet?"
without exporting anything.
"""

from __future__ import annotations

from sqlalchemy import func, select

from app.extensions import db
from app.models import StockFunding

SOURCES = {
    "profit": "Profits from sales",
    "external": "External funds",
}


def normalize(source: str | None) -> str | None:
    """Return a valid source key, ``None`` for blank, raise for anything else."""
    if not source:
        return None
    key = str(source).strip().lower()
    if key not in SOURCES:
        from app.utils import ValidationError

        raise ValidationError({"funding_source": "Choose profits from sales or external funds."})
    return key


def record(company, *, product, source: str, amount_cents: int, note: str = "",
           movement=None, user=None) -> StockFunding | None:
    """Store the funding behind one stock purchase (no commit here)."""
    key = normalize(source)
    if key is None or int(amount_cents or 0) <= 0:
        return None
    entry = StockFunding(
        company_id=company.id,
        product_id=product.id,
        movement_id=movement.id if movement is not None else None,
        user_id=user.id if user is not None else None,
        source=key,
        amount_cents=int(amount_cents),
        note=(note or "")[:160],
    )
    db.session.add(entry)
    return entry


def summary(company, limit: int = 12) -> dict:
    """Totals per source plus the latest purchases."""
    totals = db.session.execute(
        select(
            StockFunding.source,
            func.coalesce(func.sum(StockFunding.amount_cents), 0),
            func.count(StockFunding.id),
        )
        .where(StockFunding.company_id == company.id)
        .group_by(StockFunding.source)
    ).all()
    by_source = {"profit": {"amount_cents": 0, "entries": 0},
                 "external": {"amount_cents": 0, "entries": 0}}
    for source, amount, count in totals:
        if source in by_source:
            by_source[source] = {"amount_cents": int(amount or 0), "entries": int(count or 0)}

    total_cents = by_source["profit"]["amount_cents"] + by_source["external"]["amount_cents"]
    recent = (
        StockFunding.query.filter_by(company_id=company.id)
        .order_by(StockFunding.created_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "total_cents": total_cents,
        "profit": {
            "label": SOURCES["profit"],
            "amount_cents": by_source["profit"]["amount_cents"],
            "entries": by_source["profit"]["entries"],
            "share_percent": round(by_source["profit"]["amount_cents"] / total_cents * 100, 1)
            if total_cents else 0,
        },
        "external": {
            "label": SOURCES["external"],
            "amount_cents": by_source["external"]["amount_cents"],
            "entries": by_source["external"]["entries"],
            "share_percent": round(by_source["external"]["amount_cents"] / total_cents * 100, 1)
            if total_cents else 0,
        },
        "recent": [entry.to_dict() for entry in recent],
    }


def for_movements(company_id: int, movement_ids: list[int]) -> dict[int, dict]:
    """Map movement id -> funding dict, so a ledger page can show it inline."""
    ids = [int(mid) for mid in movement_ids if mid]
    if not ids:
        return {}
    rows = StockFunding.query.filter(
        StockFunding.company_id == company_id,
        StockFunding.movement_id.in_(ids),
    ).all()
    return {row.movement_id: row.to_dict() for row in rows}
