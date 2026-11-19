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
    period_comparison,
    public_registry,
    report_csv,
    stock_valuation,
    today_dashboard,
)
from app.utils import date_range

bp = Blueprint("reports", __name__, url_prefix="/api/reports")

SALES_REPORTS = {"sales", "products", "categories", "payments", "tax", "cashiers", "branches"}
PDF_ROW_LIMIT = 1200

# Extra context a report can carry next to its rows (the phone stock tab reads it).
SUMMARY_BUILDERS = {"low_stock": stock_valuation, "inventory": stock_valuation}

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
    from app.services import cache

    company = current_company()
    location_id = request.args.get("location_id", type=int)
    key = f"dashboard:{company.id}:{location_id or 0}"
    payload = dict(cache.get_or_set(key, 30, lambda: today_dashboard(company, location_id=location_id)))
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
    user_id = request.args.get("user_id", type=int)
    lean = request.args.get("lists", "1") == "0"
    ttl = _cache_ttl()  # writes invalidate the whole cache, so longer is safe
    payload = cache.get_or_set(
        _cache_key(company, "overview-lean" if lean else "overview", start, end, location_id, user_id),
        ttl,
        lambda: overview(
            company, start, end, location_id=location_id, user_id=user_id,
            include_lists=not lean,
        ),
    )
    return jsonify(payload)


@bp.get("/comparison")
@login_required
@company_required
@permission_required("reports.view")
def comparison():
    """Previous-period and best/worst history for the selected range."""
    from app.services import cache

    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    location_id = request.args.get("location_id", type=int)
    user_id = request.args.get("user_id", type=int)
    payload = cache.get_or_set(
        _cache_key(company, "comparison", start, end, location_id, user_id),
        min(120.0, max(30.0, _cache_ttl() * 2)),
        lambda: period_comparison(company, start, end, location_id=location_id, user_id=user_id),
    )
    return jsonify(payload)


@bp.get("/insights")
@login_required
@company_required
@permission_required("reports.view")
def insights():
    """Broad, period-aware management snapshot with actions and product extremes."""
    from app.services import cache
    from app.services.insights import management_insights

    company = current_company()
    default_days = int(company.module_config("reports").get("default_range_days", 30) or 30)
    start, end = date_range(request.args, default_days=default_days, company=company)
    location_id = request.args.get("location_id", type=int)
    ttl = max(30.0, _cache_ttl())
    payload = cache.get_or_set(
        _cache_key(company, "insights", start, end, location_id),
        ttl,
        lambda: management_insights(company, request.args, location_id=location_id),
    )
    return jsonify(payload)

@bp.get("/team")
@login_required
@company_required
@permission_required("reports.view")
def team():
    """Everyone who can sell in this company, for the cashier filters."""
    from app.models import User

    company = current_company()
    users = (
        User.query.filter_by(company_id=company.id)
        .order_by(User.full_name)
        .all()
    )
    return jsonify({
        "items": [
            {
                "id": user.id,
                "name": user.full_name,
                "role": user.role.name if user.role else "",
                "status": user.status,
            }
            for user in users
            if user.status == "active"
        ]
    })


@bp.get("/<key>")
@login_required
@company_required
@permission_required("reports.view")
def run_report(key: str):
    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    location_id = request.args.get("location_id", type=int)
    user_id = request.args.get("user_id", type=int)
    definition, rows = build_report(company, key, start, end, location_id=location_id, user_id=user_id)
    if definition is None:
        not_found("Unknown report.")
    payload = {
        "key": key,
        "name": definition["name"],
        "description": definition["description"],
        "columns": definition["columns"],
        "rows": rows,
        "range": {"from": start.isoformat(), "to": end.isoformat()},
    }
    summary = SUMMARY_BUILDERS.get(key)
    if summary is not None:
        payload["summary"] = summary(company)
    return jsonify(payload)


@bp.get("/<key>.csv")
@login_required
@company_required
@permission_required("reports.view", "reports.export")
def export_report(key: str):
    company = current_company()
    start, end = date_range(request.args, default_days=30, company=company)
    location_id = request.args.get("location_id", type=int)
    user_id = request.args.get("user_id", type=int)
    response = report_csv(company, key, start, end, location_id=location_id, user_id=user_id)
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


def _cache_key(company, label, start, end, location_id, user_id=None) -> str:
    return (
        f"{company.id}:{label}:{start.isoformat()}:{end.isoformat()}"
        f":{location_id or 0}:{user_id or 0}"
    )


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
    user_id = request.args.get("user_id", type=int)

    def build():
        data = dict(overview(
            company, start, end, location_id=location_id, user_id=user_id,
            include_breakdowns=True, include_lists=False,
        ))
        data["comparison"] = period_comparison(
            company, start, end, location_id=location_id, user_id=user_id,
        )
        payload = render_summary_pdf(
            company=company,
            data=data,
            start_label=start.strftime("%d %b %Y"),
            end_label=end.strftime("%d %b %Y"),
            branch_name=_branch_label(company, location_id),
        )
        return payload

    key_name = _cache_key(company, "summary.pdf", start, end, location_id, user_id)
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
    user_id = request.args.get("user_id", type=int)

    def build() -> bytes:
        return _build_report_pdf(company, key, start, end, location_id, user_id)

    key_name = _cache_key(company, f"{key}.pdf", start, end, location_id, user_id)
    hit = cache.get(key_name) is not None
    payload = cache.get_or_set(key_name, _cache_ttl(), build)
    return _pdf_response(payload, f"{key}-{start.date()}-to-{end.date()}.pdf", cached=hit)


def _build_report_pdf(company, key, start, end, location_id, user_id=None) -> bytes:
    from app.services.pdf import chart_palette, render_report_pdf

    definition, rows = build_report(company, key, start, end, location_id=location_id, user_id=user_id)
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
            company, start, end, location_id=location_id, user_id=user_id,
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
