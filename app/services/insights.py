"""Broad, period-aware management insights for the dashboard and summaries."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select

from app.extensions import db
from app.models import Layby, Location, Product, Sale, SaleItem
from app.services.reports import REVENUE_STATUSES
from app.services.timezones import (
    local_day_bounds,
    local_hour_sql,
    local_range_bounds,
    local_today,
    to_local,
)
from app.utils import date_range, format_money, iso, utcnow

TIPS_LIMIT = 10


def _currency(company) -> tuple[str, int]:
    currency = (company.settings or {}).get("currency") or {}
    return str(currency.get("symbol") or "$"), int(currency.get("decimals") or 2)


def _avg_money(cents, company) -> str:
    symbol, decimals = _currency(company)
    return format_money(cents, symbol, decimals)


def management_insights(company, args, *, location_id: int | None = None) -> dict:
    if location_id:
        branch = Location.query.filter_by(id=location_id, company_id=company.id).first()
        if branch is None:
            location_id = None
    branch = db.session.get(Location, location_id) if location_id else None
    start, end = date_range(args, default_days=30, company=company)
    span = end - start
    previous_end = start - timedelta(microseconds=1)
    previous_start = previous_end - span
    branch_clause = [Sale.location_id == location_id] if location_id else []
    sales_base = (
        Sale.company_id == company.id,
        Sale.status.in_(REVENUE_STATUSES),
    )

    def period_metrics(begin, finish) -> dict:
        row = db.session.execute(
            select(
                func.count(Sale.id),
                func.coalesce(func.sum(Sale.total_cents), 0),
                func.coalesce(func.sum(Sale.cost_cents), 0),
                func.coalesce(func.sum(Sale.discount_cents), 0),
                func.coalesce(func.sum(Sale.refunded_cents), 0),
                func.coalesce(func.sum(Sale.tax_cents), 0),
            ).where(
                *sales_base,
                Sale.created_at >= begin,
                Sale.created_at <= finish,
                *branch_clause,
            )
        ).one()
        transactions, revenue, cost = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
        profit = revenue - cost
        return {
            "transactions": transactions,
            "revenue_cents": revenue,
            "cost_cents": cost,
            "profit_cents": profit,
            "margin_percent": round(profit / revenue * 100, 1) if revenue else 0,
            "average_ticket_cents": int(round(revenue / transactions)) if transactions else 0,
            "discount_cents": int(row[3] or 0),
            "refunded_cents": int(row[4] or 0),
            "tax_cents": int(row[5] or 0),
            "discount_rate": round(int(row[3] or 0) / revenue * 100, 1) if revenue else 0,
            "refund_rate": round(int(row[4] or 0) / revenue * 100, 1) if revenue else 0,
        }

    current = period_metrics(start, end)
    previous = period_metrics(previous_start, previous_end)
    growth = (
        round(((current["revenue_cents"] - previous["revenue_cents"]) / previous["revenue_cents"]) * 100, 1)
        if previous["revenue_cents"]
        else None
    )

    today_start, today_end = local_day_bounds(company)
    today = period_metrics(today_start, today_end)
    yesterday_start, yesterday_end = local_range_bounds(
        to_local(today_start, company).date() - timedelta(days=1),
        to_local(today_start, company).date() - timedelta(days=1),
        company,
    )
    yesterday = period_metrics(yesterday_start, yesterday_end)

    product_rows = db.session.execute(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.line_total_cents), 0).label("revenue"),
            func.coalesce(func.sum(SaleItem.qty * SaleItem.cost_cents), 0).label("cost"),
            func.coalesce(func.sum(SaleItem.qty), 0).label("qty"),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            *sales_base,
            Sale.created_at >= start,
            Sale.created_at <= end,
            *branch_clause,
        )
        .group_by(SaleItem.name)
        .having(func.sum(SaleItem.qty) > 0)
    ).all()
    products = [
        {
            "name": row[0],
            "revenue_cents": int(row[1] or 0),
            "profit_cents": int(row[1] or 0) - int(row[2] or 0),
            "cost_cents": int(row[2] or 0),
            "qty": round(float(row[3] or 0), 1),
            "margin_percent": round((int(row[1] or 0) - int(row[2] or 0)) / int(row[1]) * 100, 1)
            if int(row[1] or 0)
            else 0,
        }
        for row in product_rows
    ]
    by_revenue_desc = sorted(products, key=lambda row: row["revenue_cents"], reverse=True)
    by_revenue_asc = sorted(products, key=lambda row: row["revenue_cents"])
    for row in products:
        row["share_percent"] = (
            round(row["revenue_cents"] / current["revenue_cents"] * 100, 1)
            if current["revenue_cents"]
            else 0
        )
    top_products = by_revenue_desc[:3]
    least_products = [
        row for row in by_revenue_asc
        if row["name"] not in {top["name"] for top in top_products}
    ][:3]
    profit_leaders = sorted(products, key=lambda row: row["profit_cents"], reverse=True)[:5]

    sold_ids = db.select(SaleItem.product_id).join(Sale, Sale.id == SaleItem.sale_id).where(
        *sales_base,
        Sale.created_at >= start,
        Sale.created_at <= end,
        SaleItem.product_id.isnot(None),
        *branch_clause,
    )
    slow_products = (
        Product.query.filter(
            Product.company_id == company.id,
            Product.is_active.is_(True),
            Product.id.notin_(sold_ids),
        )
        .order_by((Product.stock_qty * Product.cost_cents).desc())
        .limit(6)
        .all()
    )
    slow_movers = [
        {
            "id": product.id,
            "name": product.name,
            "stock_qty": round(product.stock_qty or 0, 2),
            "stock_value_cents": int(round((product.stock_qty or 0) * (product.cost_cents or 0))),
        }
        for product in slow_products
    ]

    low_stock = Product.query.filter(
        Product.company_id == company.id,
        Product.is_active.is_(True),
        Product.track_stock.is_(True),
        Product.stock_qty <= Product.low_stock_threshold,
    ).all()
    restock_value = int(
        sum(
            max(0, (product.low_stock_threshold or 0) - (product.stock_qty or 0))
            * (product.cost_cents or 0)
            for product in low_stock
        )
    )

    hour_rows = db.session.execute(
        select(local_hour_sql(Sale.created_at, company), func.count(Sale.id))
        .where(*sales_base, Sale.created_at >= start, Sale.created_at <= end, *branch_clause)
        .group_by(local_hour_sql(Sale.created_at, company))
        .order_by(func.count(Sale.id).desc())
        .limit(1)
    ).first()

    repeat = db.session.execute(
        select(func.count()).select_from(
            select(Sale.customer_id)
            .where(
                *sales_base,
                Sale.customer_id.isnot(None),
                Sale.created_at >= start,
                Sale.created_at <= end,
                *branch_clause,
            )
            .group_by(Sale.customer_id)
            .having(func.count(Sale.id) > 1)
            .subquery()
        )
    ).scalar() or 0

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
            *sales_base,
            Sale.created_at >= start,
            Sale.created_at <= end,
            *branch_clause,
        )
        .group_by(Location.name)
        .order_by(func.sum(Sale.total_cents).desc())
    ).all()
    branches = [
        {
            "name": row[0],
            "transactions": int(row[1] or 0),
            "revenue_cents": int(row[2] or 0),
            "profit_cents": int(row[2] or 0) - int(row[3] or 0),
        }
        for row in branch_rows
    ]

    layby_outstanding = 0
    layby_active = 0
    if company.module_enabled("layby"):
        layby_rows = Layby.query.filter_by(company_id=company.id, status="active").all()
        layby_active = len(layby_rows)
        layby_outstanding = sum(row.balance_cents for row in layby_rows)

    tips: list[dict] = []
    if low_stock:
        tips.append({
            "tone": "warning",
            "title": f"{len(low_stock)} product(s) need restocking",
            "detail": f"{_avg_money(restock_value, company)} at buying price to refill the shelves.",
            "route": "/inventory",
        })
    if slow_movers:
        names = ", ".join(row["name"] for row in slow_movers[:2])
        tips.append({
            "tone": "info",
            "title": f"{len(slow_movers)} product(s) had no sales in this period",
            "detail": f"{names}{'…' if len(slow_movers) > 2 else ''} — bundle, promote or clear them.",
            "route": "/reports",
        })
    if growth is not None and growth < 0:
        tips.append({
            "tone": "danger",
            "title": f"Revenue is down {abs(growth)}% on the previous {max(1, (end - start).days)} days",
            "detail": "Compare the busiest hours, branch performance and top products before the next push.",
            "route": "/reports",
        })
    elif growth is not None and growth > 10:
        tips.append({
            "tone": "success",
            "title": f"Revenue is up {growth}% on the previous period",
            "detail": "Protect the stock and staffing that made the gain possible.",
            "route": "/reports",
        })
    if top_products:
        best = top_products[0]
        if best["share_percent"] >= 30:
            tips.append({
                "tone": "warning",
                "title": f"{best['name']} is {best['share_percent']}% of revenue",
                "detail": "Reduce concentration by featuring complementary products.",
                "route": "/inventory",
            })
        tips.append({
            "tone": "success",
            "title": f"{best['name']} leads with {_avg_money(best['revenue_cents'], company)}",
            "detail": f"{best['qty']:g} sold · {_avg_money(best['profit_cents'], company)} profit. Keep it available.",
            "route": "/inventory",
        })
    if least_products:
        weakest = least_products[0]
        tips.append({
            "tone": "warning",
            "title": f"{weakest['name']} is your weakest seller",
            "detail": f"Only {_avg_money(weakest['revenue_cents'], company)} from {weakest['qty']:g} sold.",
            "route": "/reports",
        })
    if current["margin_percent"] and previous["margin_percent"] and current["margin_percent"] < previous["margin_percent"] - 2:
        tips.append({
            "tone": "warning",
            "title": f"Margin fell to {current['margin_percent']}% from {previous['margin_percent']}%",
            "detail": "Review discounts, buying prices and product mix.",
            "route": "/reports",
        })
    if previous["average_ticket_cents"] and current["average_ticket_cents"] < previous["average_ticket_cents"] * 0.95:
        drop = round((1 - current["average_ticket_cents"] / previous["average_ticket_cents"]) * 100)
        tips.append({
            "tone": "warning",
            "title": f"Average basket is down {drop}%",
            "detail": "Train staff on add-ons and place fast-moving impulse lines near the till.",
            "route": "/reports",
        })
    if current["profit_cents"] < 0:
        tips.append({
            "tone": "danger",
            "title": "This period is trading at a loss",
            "detail": "Check buying prices, discounting and the lowest-margin products first.",
            "route": "/reports",
        })
    if current["discount_rate"] >= 8:
        tips.append({
            "tone": "warning",
            "title": f"Discounts absorbed {current['discount_rate']}% of revenue",
            "detail": "Check whether the extra volume is paying for the discount.",
            "route": "/settings/discounts",
        })
    if current["refund_rate"] >= 3:
        tips.append({
            "tone": "danger",
            "title": f"Refunds are {current['refund_rate']}% of revenue",
            "detail": "Check product quality, fulfilment and cashier accuracy.",
            "route": "/sales",
        })
    if len(branches) > 1:
        leader, lagging = branches[0], branches[-1]
        average = sum(row["revenue_cents"] for row in branches) / len(branches)
        tips.append({
            "tone": "info",
            "title": f"{leader['name']} leads branch sales",
            "detail": f"{_avg_money(leader['revenue_cents'], company)} vs {_avg_money(lagging['revenue_cents'], company)} at {lagging['name']}.",
            "route": "/reports",
        })
        if average and lagging["revenue_cents"] < average * 0.5:
            tips.append({
                "tone": "warning",
                "title": f"{lagging['name']} is below half the branch average",
                "detail": "Review stock cover, opening hours and local demand for that shop.",
                "route": "/reports",
            })
    if hour_rows and hour_rows[0] is not None:
        tips.append({
            "tone": "info",
            "title": f"Busiest hour is {int(hour_rows[0]):02d}:00",
            "detail": "Match staffing and fresh stock to that window.",
            "route": "/reports",
        })
    if repeat:
        tips.append({
            "tone": "success",
            "title": f"{int(repeat)} repeat customers in this period",
            "detail": "Reward them with a loyalty follow-up or a targeted offer.",
            "route": "/customers",
        })
    if layby_outstanding:
        tips.append({
            "tone": "info",
            "title": f"{layby_active} active lay-by(s)",
            "detail": f"{_avg_money(layby_outstanding, company)} still to collect. Follow up before the due date.",
            "route": "/laybys",
        })
    if not tips:
        tips.append({
            "tone": "success",
            "title": "Trading looks steady",
            "detail": "Keep stock, staffing and service consistent, then review the next period.",
            "route": "/reports",
        })

    selected_branch = branch.name if branch else "All branches"
    period_from = to_local(start, company).date()
    period_to = to_local(end, company).date()
    return {
        "period": {
            "from": period_from.isoformat(),
            "to": period_to.isoformat(),
            "label": f"{period_from.strftime('%d %b')} – {period_to.strftime('%d %b %Y')}",
        },
        "branch": {"id": branch.id, "name": branch.name} if branch else {"id": None, "name": selected_branch},
        "revenue": {
            "last_30_cents": current["revenue_cents"],
            "previous_30_cents": previous["revenue_cents"],
            "growth_percent": growth,
            "today_cents": today["revenue_cents"],
            "yesterday_cents": yesterday["revenue_cents"],
            "average_ticket_cents": current["average_ticket_cents"],
            "transactions_30d": current["transactions"],
        },
        "metrics": {
            "revenue_cents": current["revenue_cents"],
            "profit_cents": current["profit_cents"],
            "margin_percent": current["margin_percent"],
            "transactions": current["transactions"],
            "average_ticket_cents": current["average_ticket_cents"],
            "discount_rate": current["discount_rate"],
            "refund_rate": current["refund_rate"],
        },
        "top_products": top_products,
        "least_products": least_products,
        "product_performance": {"top": top_products, "least": least_products},
        "profit_leaders": profit_leaders,
        "slow_movers": slow_movers,
        "branches": branches,
        "restock": {"count": len(low_stock), "value_cents": restock_value},
        "busiest_hour": int(hour_rows[0]) if hour_rows and hour_rows[0] is not None else None,
        "repeat_customers_30d": int(repeat),
        "layby": {"active": layby_active, "outstanding_cents": layby_outstanding},
        "tips": tips[:TIPS_LIMIT],
        "management_actions": tips[:TIPS_LIMIT],
        "generated_at": iso(utcnow()),
        "local_today": local_today(company).isoformat(),
    }
