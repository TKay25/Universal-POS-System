"""Reports & analytics.

Every report is declared once in :data:`REPORT_REGISTRY` and rendered by the
frontend from its column schema, which also makes CSV export automatic.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy import func, select

from app.extensions import db
from app.models import (
    Category,
    Customer,
    Department,
    Layby,
    Location,
    Product,
    Refund,
    Register,
    Sale,
    SaleItem,
    SalePayment,
    Shift,
    StockMovement,
    Supplier,
    User,
)
from app.utils import csv_response, day_buckets, format_money, iso, utcnow
from app.services.timezones import local_date_sql, local_hour_sql, local_day_bounds, to_local

REVENUE_STATUSES = ("completed", "partially_refunded", "refunded")


def _sales_query(company_id: int, start: datetime, end: datetime):
    return select(Sale).where(
        Sale.company_id == company_id,
        Sale.created_at >= start,
        Sale.created_at <= end,
        Sale.status != "voided",
    )


def _scalar(stmt, default=0):
    value = db.session.execute(stmt).scalar()
    return default if value is None else value


def overview(company, start: datetime, end: datetime, location_id: int | None = None, *,
             user_id: int | None = None,
             include_breakdowns: bool = True, include_payments: bool = True,
             include_lists: bool = True, include_branches: bool = True,
             include_departments: bool = True) -> dict:
    """Aggregate the period.

    The flags let exports fetch only the datasets they draw, which matters a lot
    when the database is remote: every skipped section is one fewer round trip.
    """
    company_id = company.id
    statuses = REVENUE_STATUSES
    # ``branch_clause`` carries the branch *and* cashier filters; every query in
    # this function spreads it so both narrow the whole report consistently.
    branch_clause = [Sale.location_id == location_id] if location_id else []
    if user_id:
        branch_clause.append(Sale.user_id == user_id)

    totals = db.session.execute(
        select(
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.tax_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        ).where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
    ).one()
    sales_cents, transactions, tax_cents, discount_cents, refunded_cents, cost_cents = totals

    items = _scalar(
        select(func.coalesce(func.sum(SaleItem.qty), 0))
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
    )

    series_rows = db.session.execute(
        select(
            local_date_sql(Sale.created_at, company).label("day"),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.cost_cents), 0),
            func.coalesce(func.sum(Sale.tax_cents), 0),
        )
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by("day")
        .order_by("day")
    ).all()
    by_day = {
        str(row[0]): {
            "sales_cents": int(row[1]),
            "transactions": int(row[2]),
            "cost_cents": int(row[3]),
            "tax_cents": int(row[4]),
        }
        for row in series_rows
    }
    series = []
    for day in day_buckets(to_local(start, company), to_local(end, company)):
        bucket = by_day.get(day, {})
        day_sales = bucket.get("sales_cents", 0)
        day_cost = bucket.get("cost_cents", 0)
        series.append(
            {
                "date": day,
                "sales_cents": day_sales,
                "transactions": bucket.get("transactions", 0),
                "cost_cents": day_cost,
                "tax_cents": bucket.get("tax_cents", 0),
                "profit_cents": day_sales - day_cost,
            }
        )

    payment_mix = []
    if include_payments:
        payment_rows = db.session.execute(
            select(
                SalePayment.method_name,
                func.coalesce(func.sum(SalePayment.amount_cents), 0),
                func.count(SalePayment.id),
            )
            .join(Sale, Sale.id == SalePayment.sale_id)
            .where(
                Sale.company_id == company_id,
                Sale.created_at >= start,
                Sale.created_at <= end,
                Sale.status.in_(statuses),
                *branch_clause,
            )
            .group_by(SalePayment.method_name)
            .order_by(func.sum(SalePayment.amount_cents).desc())
        ).all()
        payment_mix = [
            {"name": row[0], "amount_cents": int(row[1]), "count": int(row[2])} for row in payment_rows
        ]

    top_products: list[dict] = []
    least_products: list[dict] = []
    category_mix: list[dict] = []
    hourly: list[dict] = []
    if include_breakdowns:
        top_products = _top_products(company_id, start, end, statuses, branch_clause)
        least_products = _least_products(company_id, start, end, statuses, branch_clause)
        category_mix = _category_mix(company_id, start, end, statuses, branch_clause)
        hourly = _hourly_mix(company, company_id, start, end, statuses, branch_clause)

    recent = []
    low_stock = []
    if include_lists:
        recent = (
            db.session.execute(
                select(Sale)
                .where(Sale.company_id == company_id, *branch_clause)
                .order_by(Sale.created_at.desc())
                .limit(8)
            )
            .scalars()
            .all()
        )
        low_stock = (
            db.session.execute(
                select(Product)
                .where(
                    Product.company_id == company_id,
                    Product.is_active.is_(True),
                    Product.track_stock.is_(True),
                    Product.stock_qty <= Product.low_stock_threshold,
                )
                .order_by(Product.stock_qty.asc())
                .limit(20)
            )
            .scalars()
            .all()
        )

    gross_profit = int(sales_cents) - int(cost_cents)
    average = int(sales_cents) / transactions if transactions else 0
    ticket_average = int(sales_cents) / transactions if transactions else 0

    branch_rows = []
    if include_branches:
        branch_rows = db.session.execute(
            select(
                func.coalesce(Location.name, "Unassigned"),
                func.count(Sale.id),
                func.coalesce(func.sum(Sale.total_cents), 0),
                func.coalesce(func.sum(Sale.cost_cents), 0),
            )
            .select_from(Sale)
            .outerjoin(Location, Location.id == Sale.location_id)
            .where(
                Sale.company_id == company_id,
                Sale.created_at >= start,
                Sale.created_at <= end,
                Sale.status.in_(statuses),
                *branch_clause,
            )
            .group_by(Location.name)
            .order_by(func.sum(Sale.total_cents).desc())
        ).all()

    department_mix = []
    if include_departments:
        department_mix = _department_mix(company_id, start, end, statuses, branch_clause)

    team = []
    if include_breakdowns:
        team = _team_breakdown(company_id, start, end, statuses, branch_clause)

    return {
        "range": {"from": iso(start), "to": iso(end)},
        "branches": [
            {
                "name": row[0],
                "transactions": int(row[1]),
                "sales_cents": int(row[2]),
                "cost_cents": int(row[3]),
                "profit_cents": int(row[2]) - int(row[3]),
            }
            for row in branch_rows
        ],
        "cards": {
            "sales_cents": int(sales_cents),
            "transactions": int(transactions),
            "average_ticket_cents": int(round(average)),
            "items_sold": round(float(items), 3),
            "tax_cents": int(tax_cents),
            "discount_cents": int(discount_cents),
            "refunded_cents": int(refunded_cents),
            "gross_profit_cents": gross_profit,
            "cost_cents": int(cost_cents),
            "ticket_average_cents": int(round(ticket_average)),
        },
        "series": series,
        "payment_mix": payment_mix,
        "top_products": top_products,
        "least_products": least_products,
        "category_mix": category_mix,
        "department_mix": department_mix,
        "hourly": hourly,
        "team": team,
        "recent_sales": [s.to_dict() for s in recent],
        "low_stock": [p.to_dict() for p in low_stock],
    }


def _team_breakdown(company_id, start, end, statuses, branch_clause) -> list[dict]:
    """Sales and profit for every person who took money in the period."""
    rows = db.session.execute(
        select(
            func.coalesce(Sale.user_id, 0),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.cost_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
        )
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(Sale.user_id)
        .order_by(func.sum(Sale.total_cents).desc())
    ).all()
    names = {user.id: user.full_name for user in User.query.filter_by(company_id=company_id).all()}
    total = sum(int(row[1] or 0) for row in rows) or 1
    team = []
    for row in rows:
        sales = int(row[1] or 0)
        cost = int(row[3] or 0)
        transactions = int(row[2] or 0)
        team.append({
            "user_id": int(row[0] or 0),
            "name": names.get(int(row[0] or 0), "Deleted user"),
            "sales_cents": sales,
            "profit_cents": sales - cost,
            "transactions": transactions,
            "average_ticket_cents": int(round(sales / transactions)) if transactions else 0,
            "discount_cents": int(row[4] or 0),
            "refunded_cents": int(row[5] or 0),
            "share_percent": round(sales / total * 100, 1),
        })
    return team


def _top_products(company_id, start, end, statuses, branch_clause) -> list[dict]:
    rows = db.session.execute(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(SaleItem.name)
        .order_by(func.sum(SaleItem.qty).desc())
        .limit(8)
    ).all()
    return [{"name": row[0], "qty": round(float(row[1]), 3), "revenue_cents": int(row[2])} for row in rows]


def _least_products(company_id, start, end, statuses, branch_clause, limit=5) -> list[dict]:
    rows = db.session.execute(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(SaleItem.name)
        .having(func.sum(SaleItem.qty) > 0)
        .order_by(func.sum(SaleItem.line_total_cents).asc())
        .limit(limit)
    ).all()
    return [{"name": row[0], "qty": round(float(row[1]), 3), "revenue_cents": int(row[2])} for row in rows]


def _category_mix(company_id, start, end, statuses, branch_clause) -> list[dict]:
    rows = db.session.execute(
        select(
            func.coalesce(Category.name, "Uncategorised"),
            func.coalesce(Category.color, "#94a3b8"),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .select_from(SaleItem)
        .join(Sale, Sale.id == SaleItem.sale_id)
        .outerjoin(Product, Product.id == SaleItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(Category.name, Category.color)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
        .limit(8)
    ).all()
    return [
        {"name": row[0], "color": row[1] or "#94a3b8", "revenue_cents": int(row[2])} for row in rows
    ]


def _department_mix(company_id, start, end, statuses, branch_clause) -> list[dict]:
    rows = db.session.execute(
        select(
            func.coalesce(Department.name, "Unassigned"),
            func.coalesce(Department.color, "#94a3b8"),
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
            func.coalesce(func.sum(SaleItem.qty * SaleItem.cost_cents), 0),
        )
        .select_from(SaleItem)
        .join(Sale, Sale.id == SaleItem.sale_id)
        .outerjoin(Product, Product.id == SaleItem.product_id)
        .outerjoin(Department, Department.id == Product.department_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(Department.name, Department.color)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
    ).all()
    return [
        {
            "name": row[0],
            "color": row[1] or "#94a3b8",
            "qty": round(float(row[2]), 3),
            "revenue_cents": int(row[3]),
            "cost_cents": int(row[4]),
            "profit_cents": int(row[3]) - int(row[4]),
        }
        for row in rows
    ]


def _hourly_mix(company, company_id, start, end, statuses, branch_clause) -> list[dict]:
    rows = db.session.execute(
        select(
            local_hour_sql(Sale.created_at, company),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
        )
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(local_hour_sql(Sale.created_at, company))
    ).all()
    buckets = {int(row[0]): (int(row[1]), int(row[2])) for row in rows if row[0] is not None}
    return [
        {"hour": hour, "sales_cents": buckets.get(hour, (0, 0))[0],
         "transactions": buckets.get(hour, (0, 0))[1]}
        for hour in range(24)
    ]


def today_dashboard(company, location_id: int | None = None) -> dict:
    start, end = local_day_bounds(company)
    return overview(company, start, end, location_id=location_id)


# --------------------------------------------------------------------------- #
# Low stock (shared by the report, the PDF and the phone dashboard)
# --------------------------------------------------------------------------- #
def _low_stock_query(company_id: int):
    return (
        select(
            Product.name,
            Product.sku,
            func.coalesce(Department.name, "Unassigned"),
            func.coalesce(Product.stock_qty, 0),
            func.coalesce(Product.low_stock_threshold, 0),
            func.coalesce(Product.cost_cents, 0),
        )
        .select_from(Product)
        .outerjoin(Department, Department.id == Product.department_id)
        .where(
            Product.company_id == company_id,
            Product.is_active.is_(True),
            Product.track_stock.is_(True),
            func.coalesce(Product.stock_qty, 0) <= func.coalesce(Product.low_stock_threshold, 0),
        )
        .order_by(func.coalesce(Product.stock_qty, 0), Product.name)
    )


def _suggested_order(stock: float, threshold: float) -> int:
    """Bring the shelf back to twice its low-stock point."""
    return max(0, int(round(threshold * 2 - stock)))


def low_stock_items(company, limit: int | None = None) -> list[dict]:
    stmt = _low_stock_query(company.id)
    if limit:
        stmt = stmt.limit(limit)
    return [
        {
            "name": row[0],
            "sku": row[1] or "",
            "department": row[2],
            "stock": round(float(row[3] or 0), 2),
            "threshold": int(row[4] or 0),
            "order_qty": _suggested_order(float(row[3] or 0), float(row[4] or 0)),
            "value_cents": int(round(float(row[3] or 0) * int(row[5] or 0))),
        }
        for row in db.session.execute(stmt).all()
    ]


def mobile_snapshot(company, start: datetime, end: datetime, location_id: int | None = None) -> dict:
    """Everything the phone app shows for one period: six targeted queries."""
    statuses = REVENUE_STATUSES
    branch_clause = [Sale.location_id == location_id] if location_id else []
    scope = (
        Sale.company_id == company.id,
        Sale.created_at >= start,
        Sale.created_at <= end,
        Sale.status.in_(statuses),
        *branch_clause,
    )

    totals = db.session.execute(
        select(
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
            func.coalesce(func.sum(Sale.tax_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
        ).where(*scope)
    ).one()
    transactions = int(totals[0] or 0)
    sales_cents = int(totals[1] or 0)
    cost_cents = int(totals[2] or 0)
    cards = {
        "transactions": transactions,
        "sales_cents": sales_cents,
        "cost_cents": cost_cents,
        "tax_cents": int(totals[3] or 0),
        "discount_cents": int(totals[4] or 0),
        "refunded_cents": int(totals[5] or 0),
        "profit_cents": sales_cents - cost_cents,
        "average_ticket_cents": int(sales_cents / transactions) if transactions else 0,
    }

    series_rows = db.session.execute(
        select(
            local_date_sql(Sale.created_at, company).label("day"),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        )
        .where(*scope)
        .group_by("day")
        .order_by("day")
    ).all()
    by_day = {str(row[0]): (int(row[1]), int(row[2]), int(row[3])) for row in series_rows}
    series = []
    for day in day_buckets(to_local(start, company), to_local(end, company)):
        day_sales, day_count, day_cost = by_day.get(day, (0, 0, 0))
        series.append({
            "date": day,
            "sales_cents": day_sales,
            "transactions": day_count,
            "profit_cents": day_sales - day_cost,
        })

    branch_rows = db.session.execute(
        select(
            func.coalesce(Location.name, "Unassigned"),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        )
        .select_from(Sale)
        .outerjoin(Location, Location.id == Sale.location_id)
        .where(*scope)
        .group_by(Location.name)
        .order_by(func.sum(Sale.total_cents).desc())
    ).all()
    branches = [
        {
            "name": row[0],
            "transactions": int(row[1]),
            "sales_cents": int(row[2]),
            "cost_cents": int(row[3]),
            "profit_cents": int(row[2]) - int(row[3]),
        }
        for row in branch_rows
    ]

    payment_rows = db.session.execute(
        select(SalePayment.method_name, func.coalesce(func.sum(SalePayment.amount_cents), 0))
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(*scope)
        .group_by(SalePayment.method_name)
        .order_by(func.sum(SalePayment.amount_cents).desc())
    ).all()

    stock = low_stock_items(company)
    previous = _previous_period_totals(company, start, end, statuses, branch_clause)
    departments = _department_mix(company.id, start, end, statuses, branch_clause)
    return {
        "range": {"from": iso(start), "to": iso(end)},
        "cards": cards,
        "series": series,
        "branches": branches,
        "departments": departments,
        "payment_mix": [{"name": row[0], "amount_cents": int(row[1])} for row in payment_rows],
        "advice": _mobile_advice(company, cards, previous, stock, branches, departments),
        "stock": {
            "alerts": len(stock),
            "low_count": len([item for item in stock if item["stock"] > 0]),
            "out_count": len([item for item in stock if item["stock"] <= 0]),
            "items": stock,
        },
        "local_today": to_local(utcnow(), company).date().isoformat(),
        "generated_at": iso(utcnow()),
    }


def _previous_period_totals(company, start, end, statuses, branch_clause) -> dict:
    """Same-length window immediately before ``start`` - the phone's comparison."""
    span = end - start
    previous_end = start - timedelta(microseconds=1)
    previous_start = previous_end - span
    row = db.session.execute(
        select(
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        ).where(
            Sale.company_id == company.id,
            Sale.created_at >= previous_start,
            Sale.created_at <= previous_end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
    ).one()
    sales_cents = int(row[1] or 0)
    cost_cents = int(row[2] or 0)
    return {
        "transactions": int(row[0] or 0),
        "sales_cents": sales_cents,
        "profit_cents": sales_cents - cost_cents,
    }


def _money_line(cents: int, company) -> str:
    currency = (company.settings or {}).get("currency") or {}
    symbol = str(currency.get("symbol") or "$")
    decimals = int(currency.get("decimals") or 2)
    return format_money(int(cents or 0), symbol, decimals)


def _mobile_advice(company, cards, previous, stock, branches, departments) -> dict:
    """One headline plus two short actions - the phone-sized management summary."""
    sales_cents = int(cards.get("sales_cents") or 0)
    profit_cents = int(cards.get("profit_cents") or 0)
    transactions = int(cards.get("transactions") or 0)
    lines: list[str] = []
    tone = "info"
    headline = ""

    if not transactions:
        headline = "No sales in this period yet"
        lines.append("Open the till and ring up a sale - these numbers fill in as you go.")
        if stock:
            lines.append(f"{len(stock)} product{'s' if len(stock) != 1 else ''} need restocking before you open.")
        return {"tone": "info", "headline": headline, "lines": lines[:2]}

    previous_sales = int(previous.get("sales_cents") or 0)
    if previous_sales:
        change = (sales_cents - previous_sales) / previous_sales * 100
        if change >= 0:
            tone = "success"
            headline = f"Revenue is up {change:.1f}% on the previous period"
            lines.append("Keep the stock and staffing that made the gain possible.")
        else:
            tone = "warning"
            headline = f"Revenue is down {abs(change):.1f}% on the previous period"
            lines.append("Check which products slowed down and push your best seller today.")
    else:
        headline = f"{_money_line(sales_cents, company)} from {transactions} sale{'s' if transactions != 1 else ''}"
        lines.append("No earlier period to compare against yet - keep the momentum going.")

    margin = (profit_cents / sales_cents * 100) if sales_cents else 0
    if margin < 25:
        tone = "warning"
        lines.append(f"Margin is {margin:.0f}% - review buying prices or trim discounts.")
    low = len([item for item in stock if item["stock"] > 0])
    out = len([item for item in stock if item["stock"] <= 0])
    if out or low:
        parts = []
        if out:
            parts.append(f"{out} out of stock")
        if low:
            parts.append(f"{low} low")
        lines.append(f"{' and '.join(parts)} - reorder so tomorrow's sales are not lost.")
    if len(branches) > 1 and sales_cents:
        best = max(branches, key=lambda row: row["sales_cents"])
        share = best["sales_cents"] / sales_cents * 100
        if share >= 70:
            lines.append(f"{best['name']} is {share:.0f}% of sales - check what the other branches need.")
    if len(lines) < 2 and departments:
        leader = max(departments, key=lambda row: row.get("revenue_cents", 0))
        if leader.get("name"):
            lines.append(
                f"{leader['name']} leads with {_money_line(int(leader.get('revenue_cents') or 0), company)} - keep it stocked."
            )
    return {"tone": tone, "headline": headline, "lines": lines[:2]}


# --------------------------------------------------------------------------- #
# Tabular report registry
# --------------------------------------------------------------------------- #
def _rows(stmt):
    return [list(row) for row in db.session.execute(stmt).all()]


def _branch_filter(location_id, column=None):
    if not location_id:
        return []
    return [(column or Sale.location_id) == location_id]


def _user_filter(user_id):
    return [Sale.user_id == user_id] if user_id else []


def _comparison_unit(days: int) -> tuple[str, str]:
    if days <= 1:
        return "day", "day"
    if days <= 7:
        return "week", "week"
    if days <= 31:
        return "month", "month"
    if days <= 92:
        return "quarter", "quarter"
    return "year", "year"


def _bucket_key(day: date, unit: str):
    if unit == "day":
        return day
    if unit == "week":
        return day - timedelta(days=day.weekday())
    if unit == "month":
        return day.replace(day=1)
    if unit == "quarter":
        return day.year, (day.month - 1) // 3 + 1
    return (day.year,)


def _bucket_label(key, unit: str) -> str:
    if unit == "day":
        return key.strftime("%a %d %b %Y")
    if unit == "week":
        end = key + timedelta(days=6)
        return f"{key.strftime('%d %b')} – {end.strftime('%d %b %Y')}"
    if unit == "month":
        return key.strftime("%B %Y")
    if unit == "quarter":
        year, quarter = key
        return f"Q{quarter} {year}"
    return str(key[0])


def period_comparison(company, start: datetime, end: datetime,
                      location_id: int | None = None, user_id: int | None = None) -> dict:
    """Compare the selected period with history and the previous period.

    One grouped query produces the daily history; the comparison buckets are
    built in Python so day, week, month, quarter and year work identically on
    SQLite and Postgres.
    """
    scope = [
        Sale.company_id == company.id,
        Sale.status.in_(REVENUE_STATUSES),
        Sale.created_at <= end,
        *_branch_filter(location_id),
        *_user_filter(user_id),
    ]
    history_start = start - timedelta(days=365 * 5)
    rows = db.session.execute(
        select(
            local_date_sql(Sale.created_at, company).label("day"),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        )
        .where(*scope, Sale.created_at >= history_start)
        .group_by("day")
        .order_by("day")
    ).all()

    daily: dict[date, dict] = {}
    for row in rows:
        try:
            day = date.fromisoformat(str(row[0])[:10])
        except ValueError:
            continue
        revenue = int(row[1] or 0)
        cost = int(row[3] or 0)
        entry = daily.setdefault(day, {"revenue_cents": 0, "cost_cents": 0, "transactions": 0})
        entry["revenue_cents"] += revenue
        entry["cost_cents"] += cost
        entry["transactions"] += int(row[2] or 0)

    period_from = to_local(start, company).date()
    period_to = to_local(end, company).date()
    days = max(1, (period_to - period_from).days + 1)

    def totals(first: date, last: date) -> dict:
        revenue = profit = transactions = 0
        cursor = first
        while cursor <= last:
            entry = daily.get(cursor)
            if entry:
                revenue += entry["revenue_cents"]
                profit += entry["revenue_cents"] - entry["cost_cents"]
                transactions += entry["transactions"]
            cursor += timedelta(days=1)
        return {
            "revenue_cents": revenue,
            "profit_cents": profit,
            "transactions": transactions,
        }

    current = totals(period_from, period_to)
    previous_end_day = period_from - timedelta(days=1)
    previous_start_day = previous_end_day - timedelta(days=days - 1)
    previous = totals(previous_start_day, previous_end_day)
    previous["from"] = previous_start_day.isoformat()
    previous["to"] = previous_end_day.isoformat()

    unit, unit_label = _comparison_unit(days)
    current_key = _bucket_key(period_to, unit)
    buckets: dict[object, dict] = {}
    for day, entry in daily.items():
        key = _bucket_key(day, unit)
        bucket = buckets.setdefault(
            key, {"revenue_cents": 0, "profit_cents": 0, "transactions": 0}
        )
        bucket["revenue_cents"] += entry["revenue_cents"]
        bucket["profit_cents"] += entry["revenue_cents"] - entry["cost_cents"]
        bucket["transactions"] += entry["transactions"]

    history = [
        {"key": key, **value}
        for key, value in buckets.items()
        if key != current_key and value["transactions"] > 0
    ]
    best = max(history, key=lambda row: row["revenue_cents"], default=None)
    worst = min(history, key=lambda row: row["revenue_cents"], default=None)

    def benchmark(row):
        if row is None:
            return None
        result = {
            "label": _bucket_label(row["key"], unit),
            "revenue_cents": row["revenue_cents"],
            "profit_cents": row["profit_cents"],
            "transactions": row["transactions"],
        }
        if row["revenue_cents"]:
            result["vs_current_percent"] = round(
                (current["revenue_cents"] - row["revenue_cents"]) / row["revenue_cents"] * 100, 1
            )
        else:
            result["vs_current_percent"] = None
        return result

    change = None
    if previous["revenue_cents"]:
        change = round(
            (current["revenue_cents"] - previous["revenue_cents"])
            / previous["revenue_cents"] * 100,
            1,
        )
    previous.update({
        "label": "Yesterday" if unit == "day" else f"Previous {unit_label}",
        "change_percent": change,
    })

    return {
        "range": {
            "from": period_from.isoformat(),
            "to": period_to.isoformat(),
            "days": days,
        },
        "unit": unit,
        "unit_label": unit_label,
        "current": current,
        "previous": previous,
        "best": benchmark(best),
        "worst": benchmark(worst),
    }


def report_sales(company, start, end, location_id=None, user_id=None):
    stmt = (
        select(
            Sale.number,
            Sale.created_at,
            Sale.status,
            func.coalesce(Customer.name, "Walk-in"),
            func.coalesce(Sale.total_cents, 0),
            func.coalesce(Sale.tax_cents, 0),
            func.coalesce(Sale.discount_cents, 0),
            func.coalesce(Sale.refunded_cents, 0),
            func.coalesce(Sale.user_id, 0),
            func.coalesce(Sale.cost_cents, 0),
        )
        .select_from(Sale)
        .outerjoin(Customer, Customer.id == Sale.customer_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .order_by(Sale.created_at.desc())
    )
    rows = _rows(stmt)
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
        row[8] = users.get(row[8], "—")
        row.append(int(row[4] or 0) - int(row[9] or 0))
    return rows


def report_products(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
            func.coalesce(func.sum(SaleItem.discount_cents), 0),
            func.coalesce(func.sum(SaleItem.tax_cents), 0),
            func.coalesce(func.sum(SaleItem.qty * SaleItem.cost_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(SaleItem.name)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
    )
    for row in rows:
        revenue = int(row[2] or 0)
        cost = int(round(float(row[5] or 0)))
        row.append(cost)
        row.append(revenue - cost)
    return rows


def report_categories(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            func.coalesce(Category.name, "Uncategorised"),
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
            func.coalesce(func.sum(SaleItem.qty * SaleItem.cost_cents), 0),
        )
        .select_from(SaleItem)
        .join(Sale, Sale.id == SaleItem.sale_id)
        .outerjoin(Product, Product.id == SaleItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(Category.name)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
    )
    for row in rows:
        revenue = int(row[2] or 0)
        cost = int(round(float(row[3] or 0)))
        row.append(cost)
        row.append(revenue - cost)
    return rows


def report_payments(company, start, end, location_id=None, user_id=None):
    return _rows(
        select(
            SalePayment.method_name,
            func.count(SalePayment.id),
            func.coalesce(func.sum(SalePayment.amount_cents), 0),
            func.coalesce(func.sum(SalePayment.change_cents), 0),
        )
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(SalePayment.method_name)
        .order_by(func.sum(SalePayment.amount_cents).desc())
    )


def report_tax(company, start, end, location_id=None, user_id=None):
    return _rows(
        select(
            SaleItem.tax_rate_percent,
            func.coalesce(
                func.sum(SaleItem.line_subtotal_cents - SaleItem.discount_cents), 0
            ),
            func.coalesce(func.sum(SaleItem.tax_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(SaleItem.tax_rate_percent)
        .order_by(SaleItem.tax_rate_percent)
    )


def report_cashiers(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            func.coalesce(Sale.user_id, 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        )
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(Sale.user_id)
    )
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[0] = users.get(row[0], "Deleted user")
        cost = int(row[5] or 0)
        row[5] = cost
        row.append(int(row[2] or 0) - cost)
    return rows


def _inventory_rows(company):
    """Tracked products with their stock value at cost and retail price."""
    from app.services import fifo

    products = (
        Product.query.filter_by(company_id=company.id, is_active=True)
        .order_by(Product.name)
        .all()
    )
    values = fifo.value_map(company.id, [product.id for product in products])
    rows = []
    for product in products:
        value = values.get(product.id)
        if value is None:
            value = int(round(float(product.stock_qty or 0) * int(product.cost_cents or 0)))
        rows.append([
            product.name,
            product.sku,
            round(product.stock_qty or 0, 3),
            product.low_stock_threshold,
            product.cost_cents,
            product.price_cents,
            value,
        ])
    return rows


def report_inventory(company, start, end, location_id=None, user_id=None):
    return _inventory_rows(company)


def stock_valuation(company) -> dict:
    """What the shelves are worth today: at cost, at retail and the margin between."""
    rows = _inventory_rows(company)
    cost_cents = sum(int(row[6] or 0) for row in rows)
    retail_cents = sum(
        int(round(max(0.0, float(row[2] or 0)) * int(row[5] or 0))) for row in rows
    )
    return {
        "products": len(rows),
        "cost_cents": cost_cents,
        "retail_cents": retail_cents,
        "profit_cents": retail_cents - cost_cents,
    }


def report_low_stock(company, start, end, location_id=None, user_id=None):
    return [
        [
            item["name"],
            item["sku"],
            item["department"],
            item["stock"],
            item["threshold"],
            item["order_qty"],
            item["value_cents"],
        ]
        for item in low_stock_items(company)
    ]


def report_stock_movements(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            StockMovement.created_at,
            Product.name,
            StockMovement.qty_delta,
            StockMovement.balance_after,
            StockMovement.reason,
            StockMovement.reference,
        )
        .join(Product, Product.id == StockMovement.product_id)
        .where(
            StockMovement.company_id == company.id,
            StockMovement.created_at >= start,
            StockMovement.created_at <= end,
        )
        .order_by(StockMovement.created_at.desc())
        .limit(2000)
    )
    for row in rows:
        row[0] = row[0].strftime("%Y-%m-%d %H:%M") if row[0] else ""
    return rows


def report_customers(company, start, end, location_id=None, user_id=None):
    return _rows(
        select(
            Customer.name,
            Customer.email,
            Customer.phone,
            Customer.visits,
            Customer.total_spent_cents,
            Customer.loyalty_points,
            Customer.credit_balance_cents,
        )
        .where(Customer.company_id == company.id)
        .order_by(Customer.total_spent_cents.desc())
    )


def report_refunds(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            Sale.number,
            Refund.created_at,
            Refund.amount_cents,
            Refund.method,
            Refund.reason,
            Refund.restock,
        )
        .join(Sale, Sale.id == Refund.sale_id)
        .where(Refund.company_id == company.id, Refund.created_at >= start, Refund.created_at <= end,
               *_branch_filter(location_id),
               *([Refund.user_id == user_id] if user_id else []))
        .order_by(Refund.created_at.desc())
    )
    for row in rows:
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
    return rows


def report_shifts(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            func.coalesce(Shift.user_id, 0),
            Shift.opened_at,
            Shift.closed_at,
            Shift.opening_float_cents,
            Shift.expected_cash_cents,
            Shift.counted_cash_cents,
            Shift.variance_cents,
        )
        .outerjoin(Register, Register.id == Shift.register_id)
        .where(Shift.company_id == company.id, Shift.opened_at >= start, Shift.opened_at <= end,
               *_branch_filter(location_id, Register.location_id),
               *([Shift.user_id == user_id] if user_id else []))
        .order_by(Shift.opened_at.desc())
    )
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[0] = users.get(row[0], "—")
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
        row[2] = row[2].strftime("%Y-%m-%d %H:%M") if row[2] else "Open"
    return rows


def report_laybys(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            Layby.number,
            func.coalesce(Customer.name, "Walk-in"),
            Layby.status,
            Layby.total_cents,
            Layby.paid_cents,
            Layby.due_date,
            Layby.created_at,
        )
        .select_from(Layby)
        .outerjoin(Customer, Customer.id == Layby.customer_id)
        .where(Layby.company_id == company.id, Layby.created_at >= start, Layby.created_at <= end)
        .order_by(Layby.created_at.desc())
    )
    for row in rows:
        row[5] = row[5].strftime("%Y-%m-%d") if row[5] else ""
        row[6] = row[6].strftime("%Y-%m-%d %H:%M") if row[6] else ""
    return rows


def report_branches(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(
            func.coalesce(Location.name, "Unassigned"),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        )
        .select_from(Sale)
        .outerjoin(Location, Location.id == Sale.location_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
            *_branch_filter(location_id),
            *_user_filter(user_id),
        )
        .group_by(Location.name)
        .order_by(func.sum(Sale.total_cents).desc())
    )
    for row in rows:
        cost = int(row[5] or 0)
        row[5] = cost
        row.append(int(row[2] or 0) - cost)
    return rows


def report_suppliers(company, start, end, location_id=None, user_id=None):
    rows = _rows(
        select(Supplier.name, Supplier.contact_name, Supplier.phone, Supplier.email)
        .where(Supplier.company_id == company.id)
        .order_by(Supplier.name)
    )
    return rows


REPORT_REGISTRY: dict[str, dict] = {
    "sales": {
        "name": "Sales",
        "description": "Every transaction in the period with its financials.",
        "columns": [
            {"key": "number", "label": "Receipt", "type": "text"},
            {"key": "created_at", "label": "Date", "type": "text"},
            {"key": "status", "label": "Status", "type": "badge"},
            {"key": "customer", "label": "Customer", "type": "text"},
            {"key": "total", "label": "Total", "type": "money"},
            {"key": "tax", "label": "Tax", "type": "money"},
            {"key": "discount", "label": "Discount", "type": "money"},
            {"key": "refunded", "label": "Refunded", "type": "money"},
            {"key": "cashier", "label": "Cashier", "type": "text"},
            {"key": "cost", "label": "Cost", "type": "money"},
            {"key": "profit", "label": "Profit", "type": "money"},
        ],
        "build": report_sales,
    },
    "products": {
        "name": "Products sold",
        "description": "Quantity and revenue by product.",
        "columns": [
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "qty", "label": "Qty sold", "type": "number"},
            {"key": "revenue", "label": "Revenue", "type": "money"},
            {"key": "discount", "label": "Discount", "type": "money"},
            {"key": "tax", "label": "Tax", "type": "money"},
            {"key": "cost", "label": "Cost", "type": "money"},
            {"key": "profit", "label": "Profit", "type": "money"},
        ],
        "build": report_products,
    },
    "categories": {
        "name": "Categories",
        "description": "Revenue split across your categories.",
        "columns": [
            {"key": "category", "label": "Category", "type": "text"},
            {"key": "qty", "label": "Qty sold", "type": "number"},
            {"key": "revenue", "label": "Revenue", "type": "money"},
            {"key": "cost", "label": "Cost", "type": "money"},
            {"key": "profit", "label": "Profit", "type": "money"},
        ],
        "build": report_categories,
    },
    "payments": {
        "name": "Payments",
        "description": "Collected amounts grouped by payment method.",
        "columns": [
            {"key": "method", "label": "Method", "type": "text"},
            {"key": "count", "label": "Transactions", "type": "number"},
            {"key": "amount", "label": "Collected", "type": "money"},
            {"key": "change", "label": "Change given", "type": "money"},
        ],
        "build": report_payments,
    },
    "tax": {
        "name": "Tax",
        "description": "Tax collected per rate for filing.",
        "columns": [
            {"key": "rate", "label": "Rate %", "type": "percent"},
            {"key": "base", "label": "Taxable base", "type": "money"},
            {"key": "tax", "label": "Tax collected", "type": "money"},
        ],
        "build": report_tax,
    },
    "cashiers": {
        "name": "Cashiers",
        "description": "Performance by staff member.",
        "columns": [
            {"key": "user", "label": "Cashier", "type": "text"},
            {"key": "count", "label": "Transactions", "type": "number"},
            {"key": "total", "label": "Sales", "type": "money"},
            {"key": "discount", "label": "Discounts", "type": "money"},
            {"key": "refunded", "label": "Refunded", "type": "money"},
            {"key": "cost", "label": "Cost", "type": "money"},
            {"key": "profit", "label": "Profit", "type": "money"},
        ],
        "build": report_cashiers,
    },
    "inventory": {
        "name": "Inventory valuation",
        "description": "Current stock levels and stock value at FIFO cost.",
        "columns": [
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "sku", "label": "SKU", "type": "text"},
            {"key": "stock", "label": "On hand", "type": "number"},
            {"key": "threshold", "label": "Low at", "type": "number"},
            {"key": "cost", "label": "Buying price", "type": "money"},
            {"key": "price", "label": "Selling price", "type": "money"},
            {"key": "value", "label": "Stock value (FIFO)", "type": "money"},
        ],
        "build": report_inventory,
    },
    "low_stock": {
        "name": "Low stock",
        "description": "Products at or below their low-stock point, with a suggested order quantity.",
        "columns": [
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "sku", "label": "SKU", "type": "text"},
            {"key": "department", "label": "Department", "type": "text"},
            {"key": "stock", "label": "On hand", "type": "number"},
            {"key": "threshold", "label": "Low at", "type": "number"},
            {"key": "order_qty", "label": "Suggested order", "type": "number"},
            {"key": "value", "label": "Stock value", "type": "money"},
        ],
        "build": report_low_stock,
    },
    "stock_movements": {
        "name": "Stock movements",
        "description": "Every stock change with its reason.",
        "columns": [
            {"key": "created_at", "label": "When", "type": "text"},
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "delta", "label": "Change", "type": "number"},
            {"key": "balance", "label": "Balance", "type": "number"},
            {"key": "reason", "label": "Reason", "type": "badge"},
            {"key": "reference", "label": "Reference", "type": "text"},
        ],
        "build": report_stock_movements,
    },
    "customers": {
        "name": "Customers",
        "description": "Lifetime value and balances.",
        "columns": [
            {"key": "name", "label": "Customer", "type": "text"},
            {"key": "email", "label": "Email", "type": "text"},
            {"key": "phone", "label": "Phone", "type": "text"},
            {"key": "visits", "label": "Visits", "type": "number"},
            {"key": "spent", "label": "Lifetime spend", "type": "money"},
            {"key": "points", "label": "Points", "type": "number"},
            {"key": "credit", "label": "Store credit", "type": "money"},
        ],
        "build": report_customers,
    },
    "refunds": {
        "name": "Refunds",
        "description": "Returns issued in the period.",
        "columns": [
            {"key": "number", "label": "Receipt", "type": "text"},
            {"key": "created_at", "label": "When", "type": "text"},
            {"key": "amount", "label": "Amount", "type": "money"},
            {"key": "method", "label": "Method", "type": "badge"},
            {"key": "reason", "label": "Reason", "type": "text"},
            {"key": "restock", "label": "Restocked", "type": "bool"},
        ],
        "build": report_refunds,
    },
    "shifts": {
        "name": "Cash drawer",
        "description": "Shift reconciliation and variances.",
        "columns": [
            {"key": "cashier", "label": "Cashier", "type": "text"},
            {"key": "opened", "label": "Opened", "type": "text"},
            {"key": "closed", "label": "Closed", "type": "text"},
            {"key": "float", "label": "Opening float", "type": "money"},
            {"key": "expected", "label": "Expected", "type": "money"},
            {"key": "counted", "label": "Counted", "type": "money"},
            {"key": "variance", "label": "Variance", "type": "money"},
        ],
        "build": report_shifts,
    },
    "laybys": {
        "name": "Lay-bys",
        "description": "Agreements, deposits paid and balances outstanding.",
        "columns": [
            {"key": "number", "label": "Lay-by", "type": "text"},
            {"key": "customer", "label": "Customer", "type": "text"},
            {"key": "status", "label": "Status", "type": "badge"},
            {"key": "total", "label": "Total", "type": "money"},
            {"key": "paid", "label": "Paid", "type": "money"},
            {"key": "due", "label": "Due date", "type": "text"},
            {"key": "created_at", "label": "Opened", "type": "text"},
        ],
        "build": report_laybys,
    },
    "branches": {
        "name": "Branches",
        "description": "Sales performance for every shop branch.",
        "columns": [
            {"key": "branch", "label": "Branch", "type": "text"},
            {"key": "transactions", "label": "Transactions", "type": "number"},
            {"key": "sales", "label": "Sales", "type": "money"},
            {"key": "refunds", "label": "Refunds", "type": "money"},
            {"key": "discounts", "label": "Discounts", "type": "money"},
            {"key": "cost", "label": "Cost", "type": "money"},
            {"key": "profit", "label": "Profit", "type": "money"},
        ],
        "build": report_branches,
    },
    "suppliers": {
        "name": "Suppliers",
        "description": "Your supplier directory.",
        "columns": [
            {"key": "name", "label": "Supplier", "type": "text"},
            {"key": "contact", "label": "Contact", "type": "text"},
            {"key": "phone", "label": "Phone", "type": "text"},
            {"key": "email", "label": "Email", "type": "text"},
        ],
        "build": report_suppliers,
    },
}


def public_registry(company) -> list[dict]:
    """Only expose reports whose module is enabled for the company."""
    gates = {
        "inventory": "inventory",
        "low_stock": "inventory",
        "stock_movements": "inventory",
        "customers": "customers",
        "refunds": "refunds",
        "shifts": "shifts",
        "suppliers": "suppliers",
        "laybys": "layby",
        "tax": "tax_engine",
    }
    published = []
    for key, definition in REPORT_REGISTRY.items():
        module_key = gates.get(key)
        if module_key and not company.module_enabled(module_key):
            continue
        published.append(
            {
                "key": key,
                "name": definition["name"],
                "description": definition["description"],
                "columns": definition["columns"],
            }
        )
    return published


def build_report(company, key: str, start: datetime, end: datetime, location_id: int | None = None,
                 user_id: int | None = None):
    definition = REPORT_REGISTRY.get(key)
    if definition is None:
        return None, None
    rows = definition["build"](company, start, end, location_id=location_id, user_id=user_id)
    return definition, rows


def report_csv(company, key: str, start: datetime, end: datetime, location_id: int | None = None,
               user_id: int | None = None):
    definition, rows = build_report(company, key, start, end, location_id=location_id, user_id=user_id)
    if definition is None:
        return None
    headers = [column["label"] for column in definition["columns"]]
    cleaned = []
    for row in rows:
        cleaned.append(["" if value is None else value for value in row])
    return csv_response(f"{key}-{start.date()}-to-{end.date()}.csv", headers, cleaned)
