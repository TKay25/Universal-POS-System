"""Reporting endpoints and the dashboard feed."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from app.security import company_required, current_company, login_required, not_found, permission_required
from app.services.reports import build_report, overview, public_registry, report_csv, today_dashboard
from app.utils import iso, utcnow
from app.utils import date_range

bp = Blueprint("reports", __name__, url_prefix="/api/reports")


@bp.get("/dashboard")
@login_required
@company_required
def dashboard():
    company = current_company()
    payload = today_dashboard(company)
    recent = payload.pop("recent_sales")
    payload["recent_sales"] = recent
    payload["module_flags"] = {
        "loyalty": company.module_enabled("loyalty"),
        "inventory": company.module_enabled("inventory"),
        "shifts": company.module_enabled("shifts"),
        "reports": company.module_enabled("reports"),
        "customers": company.module_enabled("customers"),
    }
    return jsonify(payload)


@bp.get("/catalog")
@login_required
@company_required
@permission_required("reports.view")
def catalog():
    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    return jsonify({"reports": public_registry(company), "default_range_days": default_days})


@bp.get("/overview")
@login_required
@company_required
@permission_required("reports.view")
def overview_report():
    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    start, end = date_range(request.args, default_days=default_days, company=company)
    location_id = request.args.get("location_id", type=int)
    payload = overview(company, start, end, location_id=location_id)
    return jsonify(payload)


@bp.get("/insights")
@login_required
@company_required
@permission_required("reports.view")
def insights():
    """Management snapshot: growth, profit leaders, slow movers and actions."""
    from datetime import timedelta

    from sqlalchemy import func, select

    from app.extensions import db
    from app.models import Layby, Product, Sale, SaleItem
    from app.services.timezones import local_day_bounds, local_hour_sql, local_today

    company = current_company()
    statuses = ("completed", "partially_refunded", "refunded")
    now = utcnow()
    end = now
    start = now - timedelta(days=30)
    previous_start = start - timedelta(days=30)
    previous_end = start

    def total_between(begin, finish):
        return int(
            db.session.execute(
                select(func.coalesce(func.sum(Sale.total_cents), 0)).where(
                    Sale.company_id == company.id,
                    Sale.created_at >= begin,
                    Sale.created_at <= finish,
                    Sale.status.in_(statuses),
                )
            ).scalar()
            or 0
        )

    current_revenue = total_between(start, end)
    previous_revenue = total_between(previous_start, previous_end)
    growth = round(((current_revenue - previous_revenue) / previous_revenue) * 100, 1) if previous_revenue else None

    today_start, today_end = local_day_bounds(company)
    yesterday_start = today_start - timedelta(days=1)
    yesterday_end = today_start - timedelta(microseconds=1)
    today_revenue = total_between(today_start, today_end)
    yesterday_revenue = total_between(yesterday_start, yesterday_end)

    profit_rows = db.session.execute(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.line_total_cents), 0).label("revenue"),
            func.coalesce(func.sum(SaleItem.qty * SaleItem.cost_cents), 0).label("cost"),
            func.coalesce(func.sum(SaleItem.qty), 0).label("qty"),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.status.in_(statuses),
        )
        .group_by(SaleItem.name)
        .order_by((func.sum(SaleItem.line_total_cents) - func.sum(SaleItem.qty * SaleItem.cost_cents)).desc())
        .limit(5)
    ).all()
    profit_leaders = [
        {
            "name": row[0],
            "revenue_cents": int(row[1]),
            "profit_cents": int(row[1]) - int(row[2]),
            "qty": round(float(row[3]), 1),
        }
        for row in profit_rows
    ]

    sold_ids = db.select(SaleItem.product_id).join(Sale, Sale.id == SaleItem.sale_id).where(
        Sale.company_id == company.id,
        Sale.created_at >= start,
        SaleItem.product_id.isnot(None),
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
        sum(max(0, (product.low_stock_threshold or 0) - (product.stock_qty or 0)) * (product.cost_cents or 0)
            for product in low_stock)
    )

    basket = db.session.execute(
        select(
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
        ).where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.status.in_(statuses),
        )
    ).one()
    transactions = int(basket[0] or 0)
    average_ticket = int(round((basket[1] or 0) / transactions)) if transactions else 0

    hour_rows = db.session.execute(
        select(local_hour_sql(Sale.created_at, company), func.count(Sale.id))
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.status.in_(statuses),
        )
        .group_by(local_hour_sql(Sale.created_at, company))
        .order_by(func.count(Sale.id).desc())
        .limit(1)
    ).first()

    repeat = db.session.execute(
        select(func.count()).select_from(
            select(Sale.customer_id)
            .where(Sale.company_id == company.id, Sale.customer_id.isnot(None), Sale.created_at >= start)
            .group_by(Sale.customer_id)
            .having(func.count(Sale.id) > 1)
            .subquery()
        )
    ).scalar() or 0

    layby_outstanding = 0
    layby_active = 0
    if company.module_enabled("layby"):
        layby_rows = Layby.query.filter_by(company_id=company.id, status="active").all()
        layby_active = len(layby_rows)
        layby_outstanding = sum(row.balance_cents for row in layby_rows)

    tips = []
    if low_stock:
        tips.append({
            "tone": "warning",
            "title": f"{len(low_stock)} product(s) need restocking",
            "detail": f"About {restock_value / 100:,.2f} at buying price to refill the shelf.",
            "route": "/inventory",
        })
    if slow_movers:
        tips.append({
            "tone": "info",
            "title": f"{len(slow_movers)} product(s) had no sales in 30 days",
            "detail": "Consider a promotion, bundle or moving them to a busier department.",
            "route": "/reports",
        })
    if growth is not None and growth < 0:
        tips.append({
            "tone": "danger",
            "title": f"Revenue is down {abs(growth)}% on the previous 30 days",
            "detail": "Check your busiest hours and run a quiet-hour promotion.",
            "route": "/reports",
        })
    if profit_leaders:
        tips.append({
            "tone": "success",
            "title": f"{profit_leaders[0]['name']} is your profit leader",
            "detail": "Keep it in stock and feature it on the till.",
            "route": "/products",
        })

    return jsonify(
        {
            "revenue": {
                "last_30_cents": current_revenue,
                "previous_30_cents": previous_revenue,
                "growth_percent": growth,
                "today_cents": today_revenue,
                "yesterday_cents": yesterday_revenue,
                "average_ticket_cents": average_ticket,
                "transactions_30d": transactions,
            },
            "profit_leaders": profit_leaders,
            "slow_movers": slow_movers,
            "restock": {
                "count": len(low_stock),
                "value_cents": restock_value,
            },
            "busiest_hour": int(hour_rows[0]) if hour_rows and hour_rows[0] is not None else None,
            "repeat_customers_30d": int(repeat),
            "layby": {"active": layby_active, "outstanding_cents": layby_outstanding},
            "tips": tips,
            "generated_at": iso(now),
            "local_today": local_today(company).isoformat(),
        }
    )


@bp.get("/<key>")
@login_required
@company_required
@permission_required("reports.view")
def run_report(key: str):
    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    definition, rows = build_report(company, key, start, end)
    if definition is None:
        not_found("Unknown report.")
    return jsonify(
        {
            "key": key,
            "name": definition["name"],
            "description": definition["description"],
            "columns": definition["columns"],
            "rows": rows,
            "range": {"from": start.isoformat(), "to": end.isoformat()},
        }
    )


@bp.get("/<key>.csv")
@login_required
@company_required
@permission_required("reports.view", "reports.export")
def export_report(key: str):
    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    response = report_csv(company, key, start, end)
    if response is None:
        not_found("Unknown report.")
    return response
