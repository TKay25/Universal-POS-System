"""Timezone helpers.

Records are stored in UTC; everything is displayed and bucketed in the company's
local timezone (Africa/Harare by default, as Zimbabwe is UTC+2 all year).
"""

from __future__ import annotations

from datetime import datetime, time as dtime, timedelta, timezone

from sqlalchemy import func

from app.extensions import db

UTC = timezone.utc
DEFAULT_TIMEZONE = "Africa/Harare"


def zone_for(company=None):
    """Resolve the company's timezone, falling back to Harare."""
    from zoneinfo import ZoneInfo

    name = getattr(company, "timezone", None) or DEFAULT_TIMEZONE
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TIMEZONE)


def timezone_name(company=None) -> str:
    return getattr(company, "timezone", None) or DEFAULT_TIMEZONE


def to_local(value: datetime | None, company=None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(zone_for(company))


def format_local(value: datetime | None, company=None, fmt: str = "%d %b %Y %H:%M") -> str:
    local = to_local(value, company)
    return local.strftime(fmt) if local else ""


def offset_minutes(company=None, at: datetime | None = None) -> int:
    """Current UTC offset for the company, in minutes."""
    now = at or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    delta = now.astimezone(zone_for(company)).utcoffset() or timedelta(0)
    return int(delta.total_seconds() // 60)


def local_day_bounds(company=None, at: datetime | None = None) -> tuple[datetime, datetime]:
    """UTC bounds (naive) for the company's current local day."""
    now = at or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    tz = zone_for(company)
    local_now = now.astimezone(tz)
    start_local = datetime.combine(local_now.date(), dtime.min, tzinfo=tz)
    start_utc = start_local.astimezone(UTC).replace(tzinfo=None)
    return start_utc, start_utc + timedelta(days=1) - timedelta(microseconds=1)


def local_range_bounds(start_day, end_day, company=None) -> tuple[datetime, datetime]:
    """Convert inclusive local dates into UTC datetime bounds."""
    tz = zone_for(company)
    start = datetime.combine(start_day, dtime.min, tzinfo=tz).astimezone(UTC).replace(tzinfo=None)
    end = datetime.combine(end_day, dtime.max, tzinfo=tz).astimezone(UTC).replace(tzinfo=None)
    return start, end


def local_today(company=None):
    return datetime.now(UTC).astimezone(zone_for(company)).date()


def _modifier(company=None) -> str:
    minutes = offset_minutes(company)
    sign = "+" if minutes >= 0 else "-"
    return f"{sign}{abs(minutes)} minutes"


def _dialect() -> str:
    try:
        return db.engine.dialect.name
    except Exception:  # pragma: no cover - outside an app context
        return "sqlite"


def local_date_sql(column, company=None):
    """SQL expression yielding the local YYYY-MM-DD for a UTC timestamp."""
    if _dialect() == "postgresql":
        offset = offset_minutes(company) * 60
        return func.date(column + func.make_interval(0, 0, 0, 0, 0, 0, offset))
    return func.date(func.datetime(column, _modifier(company)))


def local_hour_sql(column, company=None):
    """SQL expression yielding the local hour (00-23) for a UTC timestamp."""
    if _dialect() == "postgresql":
        offset = offset_minutes(company) * 60
        return func.extract("hour", column + func.make_interval(0, 0, 0, 0, 0, 0, offset))
    return func.strftime("%H", func.datetime(column, _modifier(company)))
