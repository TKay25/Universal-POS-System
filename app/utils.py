"""Small, dependency-free helpers shared across blueprints."""

from __future__ import annotations

import csv
import io
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from flask import Response, request
from sqlalchemy import func, select

UTC = timezone.utc


# --------------------------------------------------------------------------- #
# Time
# --------------------------------------------------------------------------- #
def utcnow() -> datetime:
    """Naive UTC timestamp (SQLite does not keep timezone information)."""
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def date_range(args, default_days: int = 30, company=None) -> tuple[datetime, datetime]:
    """Resolve ``?from=&to=`` (local dates) into a UTC datetime range."""
    today = datetime.now(UTC).date()
    start = parse_date(args.get("from")) or (today - timedelta(days=default_days - 1))
    end = parse_date(args.get("to")) or today
    if end < start:
        start, end = end, start

    from app.services.timezones import local_range_bounds

    try:
        return local_range_bounds(start, end, company)
    except Exception:
        return (
            datetime.combine(start, datetime.min.time()),
            datetime.combine(end, datetime.max.time()),
        )


def day_buckets(start: datetime, end: datetime) -> list[str]:
    days: list[str] = []
    cursor = start.date()
    while cursor <= end.date():
        days.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return days


# --------------------------------------------------------------------------- #
# Money — every amount is stored as an integer number of minor units (cents)
# --------------------------------------------------------------------------- #
def to_cents(value, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        amount = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        return default
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def from_cents(value: int | None) -> float:
    return round((value or 0) / 100, 2)


def format_money(cents: int | None, symbol: str = "", decimals: int = 2) -> str:
    amount = (cents or 0) / 100
    formatted = f"{amount:,.{decimals}f}"
    return f"{symbol}{formatted}" if symbol else formatted


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #
def slugify(value: str, fallback: str = "company") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug[:48] or fallback


def unique_slug(model, base: str, column: str = "slug") -> str:
    candidate, suffix = base, 2
    while model.query.filter(getattr(model, column) == candidate).first():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def initials(name: str) -> str:
    parts = [p for p in re.split(r"\s+", (name or "").strip()) if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def new_token(length: int = 24) -> str:
    return secrets.token_urlsafe(length)


# --------------------------------------------------------------------------- #
# Request payload validation
# --------------------------------------------------------------------------- #
class ValidationError(Exception):
    def __init__(self, fields: dict[str, str]):
        super().__init__("Validation failed")
        self.fields = fields


RULE_KEYS = {"type", "required", "default", "min", "max", "min_len", "max_len",
             "choices", "label", "trim", "allow_blank"}


def _coerce(value, rule: dict):
    kind = rule.get("type", "str")
    if kind == "int":
        return int(value)
    if kind == "float":
        return float(value)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if kind == "money":
        return to_cents(value)
    if kind == "json":
        return value
    if kind in {"str", "email", "text"}:
        text = str(value)
        return text.strip() if rule.get("trim", True) else text
    return value


def validate(payload, rules: dict[str, dict]) -> dict:
    """Coerce and validate a JSON payload against a compact rule set.

    Raises :class:`ValidationError` carrying per-field messages so the API can
    return a structured 422 response the UI can render next to each input.
    """
    if not isinstance(payload, dict):
        raise ValidationError({"_": "A JSON object body is required."})

    clean: dict = {}
    errors: dict[str, str] = {}

    for field, rule in rules.items():
        unknown = set(rule) - RULE_KEYS
        if unknown:  # pragma: no cover - developer guard
            raise ValueError(f"Unknown rule keys for {field}: {sorted(unknown)}")

        label = rule.get("label", field.replace("_", " ").title())
        present = field in payload and payload[field] not in (None, "")
        raw = payload.get(field)

        if not present:
            if "default" in rule:
                clean[field] = rule["default"]
            elif rule.get("required"):
                errors[field] = f"{label} is required."
            continue

        try:
            value = _coerce(raw, rule)
        except (TypeError, ValueError):
            errors[field] = f"{label} must be a valid {rule.get('type', 'text')}."
            continue

        if isinstance(value, str):
            if not value and not rule.get("allow_blank"):
                if rule.get("required"):
                    errors[field] = f"{label} is required."
                continue
            if rule.get("min_len") and len(value) < rule["min_len"]:
                errors[field] = f"{label} must be at least {rule['min_len']} characters."
                continue
            if rule.get("max_len") and len(value) > rule["max_len"]:
                errors[field] = f"{label} must be at most {rule['max_len']} characters."
                continue
            if rule.get("choices") and value not in rule["choices"]:
                errors[field] = f"{label} must be one of: {', '.join(rule['choices'])}."
                continue

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "min" in rule and value < rule["min"]:
                errors[field] = f"{label} must be at least {rule['min']}."
                continue
            if "max" in rule and value > rule["max"]:
                errors[field] = f"{label} must be at most {rule['max']}."
                continue

        clean[field] = value

    if errors:
        raise ValidationError(errors)
    return clean


def body() -> dict:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValidationError({"_": "A JSON object body is required."})
    return data


# --------------------------------------------------------------------------- #
# Responses
# --------------------------------------------------------------------------- #
def paginate(query, default_per_page: int = 25, max_per_page: int = 200):
    page = max(1, request.args.get("page", type=int) or 1)
    per_page = min(max_per_page, max(1, request.args.get("per_page", type=int) or default_per_page))
    total = query.order_by(None).count()
    items = query.limit(per_page).offset((page - 1) * per_page).all()
    return items, {
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": max(1, -(-total // per_page)),
    }


def search_arg() -> str:
    return (request.args.get("q") or "").strip()


def csv_response(filename: str, headers: list[str], rows: list[list]) -> Response:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(headers)
    writer.writerows(rows)
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def count_of(model, company_id: int, *filters):
    stmt = select(func.count(model.id)).where(model.company_id == company_id, *filters)
    from app.extensions import db

    return db.session.execute(stmt).scalar_one()


# Ambiguous characters (0/o, 1/l/i) make a password read aloud over the phone risky.
TEMP_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def generate_temp_password(length: int = 10) -> str:
    """A short, unambiguous password an administrator can hand over once."""
    body = "".join(secrets.choice(TEMP_PASSWORD_ALPHABET) for _ in range(max(6, length)))
    return f"Up-{body}"
