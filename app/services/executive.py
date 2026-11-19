"""The all-rounder executive summary sent to WhatsApp at the end of the day.

The report intentionally answers four questions in one message:

* how the day went, against yesterday and the same weekday last week;
* how the week is tracking, against last week and the best week this year;
* how the month is tracking, against the same days last month and the best month;
* how the year is tracking, plus the handful of actions a manager should take.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta

from sqlalchemy import func, select

from app.extensions import db
from app.models import Sale
from app.services.reports import REVENUE_STATUSES, overview
from app.services.timezones import local_day_bounds, local_range_bounds, to_local
from app.utils import format_money, utcnow

DAILY_REPORT_HOUR = 18


def _currency(company) -> tuple[str, int]:
    currency = (company.settings or {}).get("currency") or {}
    return str(currency.get("symbol") or "$"), int(currency.get("decimals") or 2)


def _money(cents, company) -> str:
    symbol, decimals = _currency(company)
    amount = int(round(cents or 0))
    sign = "-" if amount < 0 else ""
    if symbol and symbol[-1:].isalpha():
        symbol = f"{symbol} "
    return f"{sign}{format_money(abs(amount), symbol, decimals)}"


def _short_day(value: date) -> str:
    return f"{value.day} {value.strftime('%b')}"


def _pct(value: float) -> str:
    return f"{value:.1f}%"


def _change(current: float, previous: float):
    if previous <= 0:
        return None
    return (current - previous) / previous * 100


def _comparison(current: float, previous: float, label: str) -> str:
    change = _change(current, previous)
    if change is None:
        if current > 0:
            return f"no comparison · {label} had no sales"
        return "no sales in either period"
    arrow = "▲" if change >= 0 else "▼"
    return f"{arrow} {abs(change):.1f}% vs {label}"


def _daily_rows(company, start_day: date, end_day: date) -> dict[date, dict]:
    start, end = local_range_bounds(start_day, end_day, company)
    from app.services.timezones import local_date_sql

    rows = db.session.execute(
        select(
            local_date_sql(Sale.created_at, company).label("day"),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.cost_cents), 0),
            func.coalesce(func.sum(Sale.tax_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
        )
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by("day")
        .order_by("day")
    ).all()
    result: dict[date, dict] = {}
    for row in rows:
        key = str(row[0])[:10]
        try:
            day = date.fromisoformat(key)
        except ValueError:
            continue
        result[day] = {
            "sales_cents": int(row[1] or 0),
            "transactions": int(row[2] or 0),
            "cost_cents": int(row[3] or 0),
            "tax_cents": int(row[4] or 0),
            "discount_cents": int(row[5] or 0),
            "refunded_cents": int(row[6] or 0),
        }
    return result


def _sum_period(rows: dict[date, dict], start: date, end: date) -> dict:
    totals = {
        "sales_cents": 0,
        "transactions": 0,
        "cost_cents": 0,
        "tax_cents": 0,
        "discount_cents": 0,
        "refunded_cents": 0,
    }
    day = start
    while day <= end:
        values = rows.get(day)
        if values:
            for key in totals:
                totals[key] += values.get(key, 0)
        day += timedelta(days=1)
    totals["profit_cents"] = totals["sales_cents"] - totals["cost_cents"]
    totals["margin_percent"] = (
        (totals["profit_cents"] / totals["sales_cents"] * 100)
        if totals["sales_cents"]
        else 0.0
    )
    totals["average_ticket_cents"] = (
        int(round(totals["sales_cents"] / totals["transactions"]))
        if totals["transactions"]
        else 0
    )
    totals["refund_rate"] = (
        totals["refunded_cents"] / totals["sales_cents"] * 100 if totals["sales_cents"] else 0.0
    )
    totals["discount_rate"] = (
        totals["discount_cents"] / totals["sales_cents"] * 100 if totals["sales_cents"] else 0.0
    )
    totals["start"] = start.isoformat()
    totals["end"] = end.isoformat()
    return totals


def _add_month(value: date, months: int) -> date:
    index = value.year * 12 + (value.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def _best_month(rows: dict[date, dict], year: int, until: date):
    buckets: dict[tuple[int, int], int] = {}
    for day, values in rows.items():
        if day.year == year and day <= until:
            buckets[(day.year, day.month)] = buckets.get((day.year, day.month), 0) + values["sales_cents"]
    if not buckets:
        return None
    (best_year, best_month), sales = max(buckets.items(), key=lambda item: item[1])
    return {
        "sales_cents": sales,
        "label": f"{calendar.month_abbr[best_month]} {best_year}",
        "month": best_month,
        "year": best_year,
    }


def _best_week(rows: dict[date, dict], year: int, until: date):
    start = date(year, 1, 1)
    cursor = start + timedelta(days=(-start.weekday()) % 7)
    best = None
    while cursor <= until:
        end = cursor + timedelta(days=6)
        if end > until:
            break
        values = _sum_period(rows, cursor, end)
        if values["sales_cents"] and (best is None or values["sales_cents"] > best["sales_cents"]):
            best = {
                "sales_cents": values["sales_cents"],
                "start": cursor,
                "end": end,
                "label": f"{_short_day(cursor)}–{_short_day(end)}",
            }
        cursor += timedelta(days=7)
    return best


def _best_day(rows: dict[date, dict], year: int, until: date):
    days = [
        (day, values["sales_cents"])
        for day, values in rows.items()
        if day.year == year and day <= until and values["sales_cents"]
    ]
    if not days:
        return None
    day, sales = max(days, key=lambda item: item[1])
    return {
        "sales_cents": sales,
        "date": day.isoformat(),
        "label": f"{day.strftime('%a')} {_short_day(day)}",
    }


def _period_block(
    company,
    label: str,
    period: dict,
    comparison: str,
    extra: str = "",
) -> str:
    lines = [
        f"*{label}*",
        f"Sales *{_money(period['sales_cents'], company)}*",
        (
            f"Profit {_money(period['profit_cents'], company)} · {_pct(period['margin_percent'])} margin"
            if period["sales_cents"]
            else "No sales recorded"
        ),
        f"{period['transactions']:,} sales · {_money(period['average_ticket_cents'], company)} average ticket",
        comparison,
    ]
    if extra:
        lines.append(extra)
    return "\n".join(lines)


def _advice(company, day, yesterday, week, previous_week, month, year, dashboard, today) -> list[str]:
    tips: list[str] = []
    if not day["transactions"]:
        tips.extend([
            "No sales were recorded today. Check that tills are online and staff are recording sales.",
            "If the shop was closed, mark the day in the cash drawer so tomorrow's comparison is clean.",
        ])

    day_change = _change(day["sales_cents"], yesterday["sales_cents"]) if day["transactions"] else None
    if day_change is not None and day_change <= -10:
        tips.append(
            f"Today's sales are {abs(day_change):.0f}% below yesterday. Review staffing, opening hours "
            "and stock availability before tomorrow."
        )
    elif day_change is not None and day_change >= 15:
        tips.append(
            f"Today beat yesterday by {day_change:.0f}%. Note what worked (staff, promotion, weather) "
            "and repeat it tomorrow."
        )

    week_change = _change(week["sales_cents"], previous_week["sales_cents"])
    if week_change is not None and week_change <= -5:
        tips.append(
            f"The week is running {abs(week_change):.0f}% behind last week. Push the best sellers "
            "and follow up on repeat customers."
        )

    if day["transactions"] and month["sales_cents"] and day["margin_percent"] < month["margin_percent"] - 3:
        tips.append(
            f"Today's margin ({day['margin_percent']:.1f}%) is below the month average "
            f"({month['margin_percent']:.1f}%). Check discounts and buying prices."
        )
    if day["discount_rate"] >= 8:
        tips.append(
            f"Discounts absorbed {day['discount_rate']:.1f}% of today's sales. Review promotion depth "
            "and whether the extra volume paid for it."
        )
    if day["refund_rate"] >= 3:
        tips.append(
            f"Refunds were {day['refund_rate']:.1f}% of sales. Check product quality and fulfilment "
            "before the issue repeats."
        )

    low = (dashboard.get("low_stock") or [])
    if low:
        names = ", ".join(item.get("name", "") for item in low[:3] if item.get("name"))
        tips.append(
            f"{len(low)} product{'s' if len(low) != 1 else ''} need restocking"
            + (f" ({names})." if names else ".") + " Reorder before the next busy day."
        )

    top = (dashboard.get("top_products") or [])
    if top and day["sales_cents"]:
        first = top[0]
        share = (first.get("revenue_cents") or 0) / day["sales_cents"] * 100
        if share >= 30:
            tips.append(
                f"{first.get('name', 'One product')} drove {share:.0f}% of today's revenue. Protect its "
                "stock and train the team to suggest complementary items."
            )

    hourly = [row for row in (dashboard.get("hourly") or []) if int(row.get("transactions") or 0) > 0]
    if hourly:
        peak = max(hourly, key=lambda row: int(row.get("transactions") or 0))
        tips.append(
            f"Peak hour was {peak.get('hour')}:00 with {int(peak.get('transactions') or 0)} sales. "
            "Make sure cover and fresh stock are ready for that window."
        )

    month_days = calendar.monthrange(today.year, today.month)[1]
    elapsed = today.day
    best = month.get("best_month")
    if best and elapsed and month["sales_cents"]:
        pace = month["sales_cents"] / elapsed * month_days
        if best["sales_cents"] and pace > best["sales_cents"] * 1.02:
            tips.append(
                f"At the current pace the month could reach {_money(pace, company)}, beating your best "
                f"month ({best['label']}, {_money(best['sales_cents'], company)}). Keep momentum."
            )
        elif best["sales_cents"] and pace < best["sales_cents"] * 0.8:
            tips.append(
                f"The month is pacing below your best month ({best['label']}). Plan a targeted promotion "
                "or outreach push for the remaining days."
            )

    if not tips:
        tips.append(
            "Trading is steady. Keep stock levels, staffing and service quality consistent, and review "
            "tomorrow's numbers at the same time."
        )
    return tips[:6]


def build_executive_summary(company, at: datetime | None = None) -> dict:
    """Build the WhatsApp-ready executive summary for one company."""
    now_utc = at or utcnow()
    local_now = to_local(now_utc, company)
    today = local_now.date()
    if not isinstance(local_now, datetime):
        local_now = now_utc
        today = now_utc.date()

    year_start = date(today.year, 1, 1)
    previous_year = today.year - 1
    previous_year_end = date(
        previous_year,
        today.month,
        min(today.day, calendar.monthrange(previous_year, today.month)[1]),
    )
    current_rows = _daily_rows(company, year_start, today)
    previous_rows = _daily_rows(company, date(previous_year, 1, 1), previous_year_end)

    yesterday = today - timedelta(days=1)
    last_weekday = today - timedelta(days=7)
    week_start = today - timedelta(days=today.weekday())
    previous_week_start = week_start - timedelta(days=7)
    previous_week_end = previous_week_start + (today - week_start)
    month_start = today.replace(day=1)
    previous_month_end = _add_month(today, -1)
    previous_month_start = previous_month_end.replace(day=1)
    year_stats = _sum_period(current_rows, year_start, today)

    day = _sum_period(current_rows, today, today)
    yesterday_stats = _sum_period(current_rows, yesterday, yesterday)
    last_weekday_stats = _sum_period(current_rows, last_weekday, last_weekday)
    week = _sum_period(current_rows, week_start, today)
    previous_week = _sum_period(current_rows, previous_week_start, previous_week_end)
    month = _sum_period(current_rows, month_start, today)
    previous_month = _sum_period(current_rows, previous_month_start, previous_month_end)
    last_year_same = _sum_period(previous_rows, date(previous_year, 1, 1), previous_year_end)

    best_month = _best_month(current_rows, today.year, month_start - timedelta(days=1))
    best_week = _best_week(current_rows, today.year, today)
    best_day = _best_day(current_rows, today.year, today)
    month["best_month"] = best_month

    start, end = local_day_bounds(company, at=now_utc)
    dashboard = overview(
        company,
        start,
        end,
        include_breakdowns=True,
        include_payments=True,
        include_lists=True,
        include_branches=False,
        include_departments=False,
    )

    day_comparison = (
        f"{_comparison(day['sales_cents'], yesterday_stats['sales_cents'], 'yesterday')} · "
        f"{_comparison(day['sales_cents'], last_weekday_stats['sales_cents'], 'last ' + today.strftime('%a'))}"
    )
    week_extra = (
        f"Best week this year: {_money(best_week['sales_cents'], company)} ({best_week['label']})"
        if best_week
        else ""
    )
    month_extra_parts = []
    if best_month:
        month_extra_parts.append(
            f"Best month this year: {_money(best_month['sales_cents'], company)} ({best_month['label']})"
        )
    month_extra = " · ".join(month_extra_parts)
    year_extra_parts = []
    if best_month:
        year_extra_parts.append(f"Best month: {_money(best_month['sales_cents'], company)} ({best_month['label']})")
    if best_day:
        year_extra_parts.append(f"Best day: {_money(best_day['sales_cents'], company)} ({best_day['label']})")
    year_extra = " · ".join(year_extra_parts)

    sections = [
        _period_block(
            company,
            f"TODAY · {today.strftime('%a')} {_short_day(today)}",
            day,
            day_comparison,
        ),
        _period_block(
            company,
            f"THIS WEEK · {_short_day(week_start)}–{_short_day(today)}",
            week,
            _comparison(week["sales_cents"], previous_week["sales_cents"], "same days last week"),
            week_extra,
        ),
        _period_block(
            company,
            f"THIS MONTH · {_short_day(month_start)}–{_short_day(today)}",
            month,
            _comparison(month["sales_cents"], previous_month["sales_cents"], "same days last month"),
            month_extra,
        ),
        _period_block(
            company,
            f"THIS YEAR · {_short_day(year_start)}–{_short_day(today)}",
            year_stats,
            _comparison(year_stats["sales_cents"], last_year_same["sales_cents"], "same period last year"),
            year_extra,
        ),
    ]

    top_products = dashboard.get("top_products") or []
    if top_products:
        lines = ["*TOP PRODUCTS TODAY*"]
        for item in top_products[:3]:
            lines.append(
                f"• {item.get('name', 'Product')} — {_money(item.get('revenue_cents') or 0, company)}"
                f" ({int(item.get('qty') or 0):,} sold)"
            )
        sections.append("\n".join(lines))

    payment_mix = dashboard.get("payment_mix") or []
    if payment_mix and day["sales_cents"]:
        total = sum(int(row.get("amount_cents") or 0) for row in payment_mix) or day["sales_cents"]
        parts = [
            f"{row.get('name', 'Other')} {(int(row.get('amount_cents') or 0) / total * 100):.0f}%"
            for row in payment_mix[:3]
        ]
        sections.append("*PAYMENTS TODAY*\n" + " · ".join(parts))

    advice = _advice(company, day, yesterday_stats, week, previous_week, month, year_stats, dashboard, today)
    sections.append("*MANAGEMENT ADVICE*\n" + "\n".join(f"• {tip}" for tip in advice))

    tz_name = local_now.strftime("%Z") if isinstance(local_now, datetime) else ""
    stamp = (
        f"{local_now.strftime('%a')} {local_now.day} {local_now.strftime('%b %Y · %H:%M')}"
        if isinstance(local_now, datetime)
        else ""
    )
    header = (
        f"*{company.name}*\n"
        f"_Executive summary · {stamp}{(' ' + tz_name) if tz_name else ''}_"
    )
    footer = "_Sent automatically by Universal POS. Reply to your administrator to change recipients._"
    text = "\n\n".join([header] + sections + [footer]).strip()

    return {
        "title": f"{company.name} executive summary",
        "local_date": today.isoformat(),
        "generated_at": local_now.isoformat() if isinstance(local_now, datetime) else "",
        "text": text,
        "metrics": {
            "today": day,
            "yesterday": yesterday_stats,
            "week": week,
            "previous_week": previous_week,
            "month": month,
            "previous_month": previous_month,
            "year": year_stats,
            "last_year_same": last_year_same,
            "best_month": best_month,
            "best_week": best_week,
            "best_day": best_day,
        },
        "advice": advice,
        "top_products": top_products[:3],
        "payment_mix": payment_mix[:3],
        "low_stock": (dashboard.get("low_stock") or [])[:10],
    }
