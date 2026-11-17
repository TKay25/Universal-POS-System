"""FIFO inventory costing.

Every receipt of stock creates a cost layer (quantity + buying price). Selling
consumes the oldest layers first, so cost of goods sold — and therefore profit —
uses the price the goods were actually bought at, not the latest price on file.

Layers are the source of truth for stock value; ``Product.stock_qty`` stays the
fast-running balance used by the till.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select

from app.extensions import db
from app.models import Product, StockLayer
from app.utils import utcnow

EPSILON = 0.0005


def _layers(product: Product):
    return (
        StockLayer.query.filter_by(product_id=product.id, company_id=product.company_id)
        .order_by(StockLayer.received_at.asc(), StockLayer.id.asc())
        .all()
    )


def open_layer(
    product: Product,
    qty: float,
    unit_cost_cents: int,
    *,
    source: str = "receive",
    reference: str = "",
    received_at: datetime | None = None,
) -> StockLayer | None:
    """Record stock arriving at a known buying price."""
    qty = float(qty or 0)
    if qty <= 0:
        return None
    layer = StockLayer(
        company_id=product.company_id,
        product_id=product.id,
        received_at=received_at or utcnow(),
        qty_received=round(qty, 3),
        qty_remaining=round(qty, 3),
        unit_cost_cents=max(0, int(unit_cost_cents or 0)),
        source=source,
        reference=(reference or "")[:80],
    )
    db.session.add(layer)
    return layer


def ensure_layers(product: Product) -> list[StockLayer]:
    """Give legacy stock a starting layer at its recorded buying price."""
    layers = _layers(product)
    if layers:
        return layers
    opening = float(product.stock_qty or 0)
    if opening > 0 and product.track_stock:
        open_layer(
            product,
            opening,
            int(product.cost_cents or 0),
            source="opening",
            reference="opening balance",
        )
        db.session.flush()
        layers = _layers(product)
    return layers


def receive(
    product: Product,
    qty: float,
    unit_cost_cents: int | None = None,
    *,
    source: str = "receive",
    reference: str = "",
) -> StockLayer | None:
    """Bring stock in. Falls back to the product's buying price when none is given."""
    ensure_layers(product)
    cost = int(unit_cost_cents if unit_cost_cents is not None else (product.cost_cents or 0))
    return open_layer(product, qty, cost, source=source, reference=reference)


def consume(product: Product, qty: float) -> int:
    """Take ``qty`` out of stock oldest-first; returns the exact cost in cents."""
    qty = float(qty or 0)
    if qty <= 0:
        return 0
    layers = ensure_layers(product)
    remaining = qty
    cost_total = 0.0
    for layer in layers:
        if remaining <= EPSILON:
            break
        available = float(layer.qty_remaining or 0)
        if available <= EPSILON:
            continue
        take = min(available, remaining)
        cost_total += take * int(layer.unit_cost_cents or 0)
        layer.qty_remaining = round(available - take, 3)
        remaining -= take
    if remaining > EPSILON:
        # Stock sold beyond the layers on file (legacy data or negative stock
        # allowed): value the shortfall at today's buying price.
        cost_total += remaining * int(product.cost_cents or 0)
    return int(round(cost_total))


def restore(product: Product, qty: float, unit_cost_cents: int, *, reference: str = "") -> None:
    """Put returned goods back as a fresh layer at the cost they left at."""
    if float(qty or 0) <= 0:
        return
    ensure_layers(product)
    open_layer(product, qty, unit_cost_cents, source="return", reference=reference)


def stock_value_cents(product: Product) -> int | None:
    """FIFO value of what is on hand, or ``None`` when no layers exist yet."""
    rows = db.session.execute(
        select(
            func.coalesce(func.sum(StockLayer.qty_remaining * StockLayer.unit_cost_cents), 0),
            func.count(StockLayer.id),
        ).where(StockLayer.product_id == product.id, StockLayer.company_id == product.company_id)
    ).one()
    if not rows[1]:
        return None
    return int(round(float(rows[0] or 0)))


def value_map(company_id: int, product_ids: list[int] | None = None) -> dict[int, int]:
    """FIFO stock value for many products in one query."""
    stmt = (
        select(
            StockLayer.product_id,
            func.sum(StockLayer.qty_remaining * StockLayer.unit_cost_cents),
        )
        .where(StockLayer.company_id == company_id)
        .group_by(StockLayer.product_id)
    )
    if product_ids:
        stmt = stmt.where(StockLayer.product_id.in_(product_ids))
    return {row[0]: int(round(float(row[1] or 0))) for row in db.session.execute(stmt).all()}


def backfill_company(company_id: int) -> int:
    """Create opening layers for products that have stock but no layers yet."""
    covered = db.session.execute(
        select(StockLayer.product_id).where(StockLayer.company_id == company_id).group_by(StockLayer.product_id)
    ).scalars().all()
    query = Product.query.filter(
        Product.company_id == company_id,
        Product.track_stock.is_(True),
        Product.stock_qty > 0,
    )
    if covered:
        query = query.filter(Product.id.notin_(list(covered)))
    created = 0
    for product in query.all():
        if open_layer(product, product.stock_qty, int(product.cost_cents or 0),
                      source="opening", reference="opening balance"):
            created += 1
    if created:
        db.session.commit()
    return created
