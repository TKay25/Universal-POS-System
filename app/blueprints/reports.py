"""Reporting endpoints and the dashboard feed."""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request

from app.extensions import db
from app.models import Location
from app.security import company_required, current_company, login_required, not_found, permission_required
from app.services.reports import (
    build_report,
    mobile_snapshot,
    overview,
    public_registry,
    report_csv,
    today_dashboard,
)
from app.utils import iso, utcnow
from app.utils import date_range

bp = Blueprint("reports", __name__, url_prefix="/api/reports")

SALES_REPORTS = {"sales", "products", "categories", "payments", "tax", "cashiers", "branches"}
PDF_ROW_LIMIT = 1200

# What the phone dashboard offers. Kept short on purpose: downloadable, nothing else.
MOBILE_DOWNLOADS = (
    ("summary", "Summary", "Sales, profit and the daily trend"),
    ("sales", "Sales", "Every transaction in the period"),
    ("products", "Products sold", "Quantity, revenue and profit by product"),
    ("low_stock", "Low stock", "What to reorder, with suggested quantities"),
    ("inventory", "Inventory valuation", "Stock on hand valued at buying price"),
    ("branches", "Branches", "Sales and profit for every shop branch"),
)



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


@bp.get("/mobile")
@login_required
@company_required
@permission_required("reports.view")
def mobile():
    """Everything the phone app shows for one period, in one round trip."""
    from app.services import cache

    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    start, end = date_range(request.args, default_days=default_days, company=company)
    location_id = request.args.get("location_id", type=int)
    payload = cache.get_or_set(
        _cache_key(company, "mobile", start, end, location_id),
        _cache_ttl() / 2,
        lambda: mobile_snapshot(company, start, end, location_id),
    )
    payload = dict(payload)
    payload["downloads"] = _mobile_downloads(company)
    return jsonify(payload)


def _mobile_downloads(company) -> list[dict]:
    available = {entry["key"] for entry in public_registry(company)}
    items = []
    for key, name, description in MOBILE_DOWNLOADS:
        if key != "summary" and key not in available:
            continue
        items.append({"key": key, "name": name, "description": description})
    return items


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
    from app.services import cache

    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    start, end = date_range(request.args, default_days=default_days, company=company)
    location_id = request.args.get("location_id", type=int)
    ttl = _cache_ttl() / 2  # dashboards refresh a little more eagerly
    payload = cache.get_or_set(
        _cache_key(company, "overview", start, end, location_id),
        ttl,
        lambda: overview(company, start, end, location_id=location_id),
    )
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


# --------------------------------------------------------------------------- #
# PDF exports
# --------------------------------------------------------------------------- #
def _pdf_response(payload: bytes, filename: str, cached: bool | None = None) -> Response:
    response = Response(payload, mimetype="application/pdf")
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    response.headers["Cache-Control"] = "private, max-age=60"
    if cached is not None:
        response.headers["X-Report-Cache"] = "hit" if cached else "miss"
    return response


def _branch_label(company, location_id) -> str:
    if not location_id:
        return ""
    row = db.session.get(Location, location_id)
    return row.name if row and row.company_id == company.id else ""


def _column_weights(columns, rows, symbol):
    """Width each column by what it actually contains so headers never wrap mid-word."""
    from app.services.pdf import _format

    weights = []
    for index, column in enumerate(columns):
        lengths = [len(str(column.get("label", "")))]
        for row in rows[:200]:
            value = row[index] if index < len(row) else None
            lengths.append(len(_format(value, column.get("type", "text"), symbol)))
        target = sorted(lengths)[int(len(lengths) * 0.8)]
        weight = min(max(target, 5), 20)
        if index == 0:
            weight = min(weight * 1.15, 22)
        weights.append({**column, "weight": weight})
    return weights


def _money(cents, symbol):
    from app.services.pdf import _money as pdf_money

    return pdf_money(cents, symbol)


def _cache_ttl() -> float:
    from flask import current_app

    try:
        return float(current_app.config.get("REPORT_CACHE_SECONDS", 60))
    except (TypeError, ValueError):
        return 60.0


def _cache_key(company, label, start, end, location_id) -> str:
    return f"{company.id}:{label}:{start.isoformat()}:{end.isoformat()}:{location_id or 0}"


@bp.get("/summary.pdf")
@login_required
@company_required
@permission_required("reports.view", "reports.export")
def summary_pdf():
    from app.services import cache
    from app.services.pdf import render_summary_pdf

    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    start, end = date_range(request.args, default_days=default_days, company=company)
    location_id = request.args.get("location_id", type=int)

    def build():
        data = overview(
            company, start, end, location_id=location_id,
            include_breakdowns=False, include_lists=False,
        )
        payload = render_summary_pdf(
            company=company,
            data=data,
            start_label=start.strftime("%d %b %Y"),
            end_label=end.strftime("%d %b %Y"),
            branch_name=_branch_label(company, location_id),
        )
        return payload

    key_name = _cache_key(company, "summary.pdf", start, end, location_id)
    hit = cache.get(key_name) is not None
    payload = cache.get_or_set(key_name, _cache_ttl(), build)
    return _pdf_response(payload, f"summary-{start.date()}-to-{end.date()}.pdf", cached=hit)


@bp.get("/<key>.pdf")
@login_required
@company_required
@permission_required("reports.view", "reports.export")
def export_report_pdf(key: str):
    from app.services import cache

    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    location_id = request.args.get("location_id", type=int)

    def build() -> bytes:
        return _build_report_pdf(company, key, start, end, location_id)

    key_name = _cache_key(company, f"{key}.pdf", start, end, location_id)
    hit = cache.get(key_name) is not None
    payload = cache.get_or_set(key_name, _cache_ttl(), build)
    return _pdf_response(payload, f"{key}-{start.date()}-to-{end.date()}.pdf", cached=hit)


def _build_report_pdf(company, key, start, end, location_id) -> bytes:
    from app.services.pdf import chart_palette, render_report_pdf

    definition, rows = build_report(company, key, start, end)
    if definition is None:
        not_found("Unknown report.")

    settings = company.settings or {}
    symbol = (settings.get("currency") or {}).get("symbol", "$")
    palette = chart_palette(company)
    truncated = len(rows) > PDF_ROW_LIMIT
    table_rows = rows[:PDF_ROW_LIMIT]
    columns = _column_weights(definition["columns"], table_rows, symbol)

    kpis = []
    charts = []
    if key in SALES_REPORTS:
        data = overview(
            company, start, end, location_id=location_id,
            include_payments=(key == "payments"),
            include_lists=False,
            include_branches=(key == "branches"),
        )
        cards = data.get("cards") or {}
        sales_cents = int(cards.get("sales_cents") or 0)
        cost_cents = int(cards.get("cost_cents") or 0)
        profit_cents = int(cards.get("gross_profit_cents") or 0)
        margin = (profit_cents / sales_cents * 100) if sales_cents else 0
        kpis = [
            {"label": "Net sales", "value": _money(sales_cents, symbol),
             "hint": f"{int(cards.get('transactions') or 0):,} transactions"},
            {"label": "Gross profit", "value": _money(profit_cents, symbol),
             "hint": f"{margin:.1f}% margin", "tone": "#0f9d58" if profit_cents >= 0 else "#d92d20"},
            {"label": "Cost of goods", "value": _money(cost_cents, symbol),
             "hint": f"{int(cards.get('items_sold') or 0):,} items sold"},
            {"label": "Average ticket", "value": _money(cards.get("average_ticket_cents"), symbol),
             "hint": f"Tax {_money(cards.get('tax_cents'), symbol)}"},
        ]

        series = data.get("series") or []
        if series:
            charts.append({
                "type": "line",
                "title": "Revenue and profit trend",
                "labels": [row["date"][5:] for row in series],
                "series": [
                    {"name": "Revenue", "color": palette[0],
                     "values": [round((row.get("sales_cents") or 0) / 100) for row in series]},
                    {"name": "Profit", "color": "#0f9d58",
                     "values": [round((row.get("profit_cents") or 0) / 100) for row in series]},
                ],
            })

        second = _second_chart(key, table_rows, columns, data, symbol, palette)
        if second:
            charts.append(second)
    elif key == "low_stock":
        out_count = sum(1 for row in rows if float(row[3] or 0) <= 0)
        value_cents = sum(int(row[6] or 0) for row in rows)
        kpis = [
            {"label": "Reordering", "value": f"{len(rows):,}",
             "hint": "products at or below the low-stock point"},
            {"label": "Out of stock", "value": f"{out_count:,}",
             "hint": f"{len(rows) - out_count:,} still have some units left",
             "tone": "#d92d20" if out_count else "#0f9d58"},
            {"label": "Units to order", "value": f"{sum(int(row[5] or 0) for row in rows):,}",
             "hint": "suggested, brings stock back to 2× the low point"},
            {"label": "Value on hand", "value": _money(value_cents, symbol),
             "hint": "at buying price"},
        ]
        groups: dict[str, int] = {}
        for row in rows:
            groups[str(row[2])] = groups.get(str(row[2]), 0) + int(row[6] or 0)
        top = sorted(groups.items(), key=lambda item: item[1], reverse=True)[:6]
        if top:
            charts.append({
                "type": "bar",
                "title": "Value on hand by department",
                "rows": [
                    {"label": label, "value": amount, "display": _money(amount, symbol),
                     "color": palette[index % len(palette)]}
                    for index, (label, amount) in enumerate(top)
                ],
            })

    branches = db.session.execute(
        db.select(Location.name).where(Location.company_id == company.id, Location.id == location_id)
    ).scalar() if location_id else None

    return render_report_pdf(
        company=company,
        title=definition["name"],
        subtitle=definition["description"],
        period_label=f"{start.strftime('%d %b %Y')} → {end.strftime('%d %b %Y')}",
        branch_name=branches or "",
        columns=columns,
        rows=table_rows,
        kpis=kpis,
        charts=charts,
        footer_note=(
            f"Showing the first {PDF_ROW_LIMIT:,} of {len(rows):,} rows — export CSV for the full set."
            if truncated else ""
        ),
    )


def _second_chart(key, rows, columns, data, symbol, palette):
    """The second chart packs the most useful comparison for that report."""
    from app.services.pdf import _money as pdf_money

    def money_index():
        for index, column in enumerate(columns):
            if column.get("type") == "money" and index > 0:
                return index
        return None

    if key == "payments":
        mix = data.get("payment_mix") or []
        if not mix:
            return None
        return {
            "type": "bar",
            "title": "Collected by payment method",
            "rows": [
                {
                    "label": row["name"],
                    "value": row.get("amount_cents") or 0,
                    "display": pdf_money(row.get("amount_cents"), symbol),
                    "color": palette[index % len(palette)],
                }
                for index, row in enumerate(mix[:6])
            ],
        }

    if key == "tax":
        if not rows:
            return None
        return {
            "type": "bar",
            "title": "Tax collected by rate",
            "rows": [
                {
                    "label": f"{row[0]:g}%" if isinstance(row[0], (int, float)) else str(row[0]),
                    "value": row[2] or 0,
                    "display": pdf_money(row[2], symbol),
                    "color": palette[index % len(palette)],
                }
                for index, row in enumerate(rows[:6])
            ],
        }

    index = money_index()
    if key == "sales":
        top = (data.get("top_products") or [])[:6]
        if not top:
            return None
        return {
            "type": "bar",
            "title": "Top products by revenue",
            "rows": [
                {
                    "label": row["name"],
                    "value": row.get("revenue_cents") or 0,
                    "display": pdf_money(row.get("revenue_cents"), symbol),
                    "color": palette[i % len(palette)],
                }
                for i, row in enumerate(top)
            ],
        }

    if index is None or not rows:
        return None

    titles = {
        "products": "Top products by revenue",
        "categories": "Revenue by category",
        "cashiers": "Revenue by cashier",
        "branches": "Revenue by branch",
    }
    return {
        "type": "bar",
        "title": titles.get(key, "Revenue breakdown"),
        "rows": [
            {
                "label": str(row[0]),
                "value": row[index] or 0,
                "display": pdf_money(row[index], symbol),
                "color": palette[i % len(palette)],
            }
            for i, row in enumerate(rows[:6])
        ],
    }
