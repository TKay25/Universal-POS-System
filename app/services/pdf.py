"""Elegant, fast PDF exports for reports.

Uses ReportLab (pure Python, no browser engine) so a month of sales exports in
well under a second. Layout: branded header, KPI strip, up to two charts and a
zebra table with a totals row, then page-numbered footer.
"""

from __future__ import annotations

import base64
import io
import math
import re
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from app.services.timezones import format_local, local_today, timezone_name, zone_for
from reportlab.platypus import Flowable

# Palette mirrors the app design tokens.
INK = "#101322"
MUTED = "#7d879e"
BORDER = "#e4e7f0"
SURFACE = "#f7f8fc"
PRIMARY = "#5b5bd6"
ACCENT = "#22d3ee"
SUCCESS = "#0f9d58"
WARNING = "#c2760a"
DANGER = "#d92d20"

A4_WIDTH, A4_HEIGHT = 595.27, 841.89
MARGIN_X = 38
CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2


def _hex(value: str):
    from reportlab.lib.colors import HexColor

    return HexColor(value)


def _money(cents, symbol="$") -> str:
    if cents in (None, ""):
        return "—"
    amount = int(cents) / 100
    sign = "-" if amount < 0 else ""
    return f"{sign}{symbol}{abs(amount):,.2f}"


def _number(value) -> str:
    if value in (None, ""):
        return "—"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return str(value)
    if numeric.is_integer():
        return f"{int(numeric):,}"
    return f"{numeric:,.2f}"


def _percent(value) -> str:
    return f"{float(value or 0):.1f}%"


def _format(value, kind: str, symbol: str) -> str:
    if kind == "money":
        return _money(value, symbol)
    if kind == "percent":
        return _percent(value)
    if kind == "number":
        return _number(value)
    if kind == "bool":
        return "Yes" if value else "No"
    if value is None or value == "":
        return "—"
    return str(value)


def _smooth_points(values, x_for, y_for):
    """Monotone cubic sampling so lines curve without overshooting the data."""
    points = [(x_for(index), y_for(value)) for index, value in enumerate(values)]
    if len(points) < 3:
        return points
    count = len(points)
    dx = [points[index + 1][0] - points[index][0] or 0.0001 for index in range(count - 1)]
    slopes = [(points[index + 1][1] - points[index][1]) / dx[index] for index in range(count - 1)]
    tangents = [0.0] * count
    tangents[0] = slopes[0]
    tangents[-1] = slopes[-1]
    for index in range(1, count - 1):
        if slopes[index - 1] * slopes[index] <= 0:
            tangents[index] = 0.0
        else:
            w1 = 2 * dx[index] + dx[index - 1]
            w2 = dx[index] + 2 * dx[index - 1]
            denominator = w1 / slopes[index - 1] + w2 / slopes[index]
            tangents[index] = (w1 + w2) / denominator if abs(denominator) > 1e-9 else 0.0

    sampled = []
    for index in range(count - 1):
        x0, y0 = points[index]
        x1, y1 = points[index + 1]
        span = x1 - x0
        for step in range(8):
            t = step / 8
            h00 = 2 * t ** 3 - 3 * t ** 2 + 1
            h10 = t ** 3 - 2 * t ** 2 + t
            h01 = -2 * t ** 3 + 3 * t ** 2
            h11 = t ** 3 - t ** 2
            y = (h00 * y0 + h10 * tangents[index] * span
                 + h01 * y1 + h11 * tangents[index + 1] * span)
            sampled.append((x0 + span * t, y))
    sampled.append(points[-1])
    return sampled


class _Charts:
    """Hand-drawn charts sized for a portrait page (max two)."""

    @staticmethod
    def line(width, height, series, labels, max_points=14):
        from reportlab.graphics.shapes import Circle, Drawing, Line, Polygon, PolyLine, String
        from reportlab.lib.colors import Color

        drawing = Drawing(width, height)
        drawing.hAlign = "LEFT"
        left, right, top, bottom = 46, 10, 12, 22
        plot_w = width - left - right
        plot_h = height - top - bottom
        values = [value for line in series for value in line["values"]]
        peak = max(values) if values else 1
        peak = peak if peak > 0 else 1
        ceiling = _nice_ceiling(peak)

        drawing.add(Line(left, bottom, width - right, bottom,
                         strokeColor=_hex("#e9ecf4"), strokeWidth=0.6))
        for step in range(5):
            value = ceiling * step / 4
            y = bottom + plot_h * (step / 4)
            drawing.add(Line(left, y, width - right, y, strokeColor=_hex("#eef1f7"),
                             strokeWidth=0.45, strokeDashArray=[1.5, 3]))
            drawing.add(String(left - 7, y - 2.5, _compact(value), fontSize=6.1,
                               fillColor=_hex(MUTED), textAnchor="end"))

        count = max(len(labels), 1)
        stride = max(1, count // max_points)

        def x_for(index):
            return left + (plot_w / 2 if count == 1 else (index / (count - 1)) * plot_w)

        def y_for(value):
            return bottom + plot_h * (value / ceiling)

        for line in series:
            points = _smooth_points(line["values"], x_for, y_for)
            if len(points) < 2:
                continue
            stroke = _hex(line["color"])
            if len(series) == 1:
                area = points + [(points[-1][0], bottom), (points[0][0], bottom)]
                drawing.add(Polygon(
                    [coord for point in area for coord in point],
                    fillColor=Color(stroke.red, stroke.green, stroke.blue, alpha=0.10),
                    strokeColor=None,
                ))
            drawing.add(PolyLine(
                [coord for point in points for coord in point],
                strokeColor=stroke, strokeWidth=2.0, strokeLineJoin=1, strokeLineCap=1,
            ))
            for index in range(0, count, stride):
                x = x_for(index)
                y = y_for(line["values"][index])
                drawing.add(Circle(x, y, 2.8, fillColor=_hex("#ffffff"), strokeColor=None))
                drawing.add(Circle(x, y, 1.8, fillColor=stroke, strokeColor=None))

        for index in range(0, count, stride):
            text_anchor = "start" if index == 0 else "end" if index == count - 1 else "middle"
            drawing.add(String(x_for(index), 6, labels[index], fontSize=6.1,
                               fillColor=_hex(MUTED), textAnchor=text_anchor))
        return drawing

    @staticmethod
    def bars(width, height, rows, primary=PRIMARY, max_rows=6):
        from reportlab.graphics.shapes import Drawing, Rect, String

        drawing = Drawing(width, height)
        drawing.hAlign = "LEFT"
        label_w = 122
        value_w = 74
        track_x = label_w + 8
        track_w = max(30, width - track_x - value_w)
        peak = max([row["value"] for row in rows] or [1]) or 1
        row_h = min(17, max(12, (height - 4) / max(len(rows), 1)))
        for index, row in enumerate(rows[:max_rows]):
            y = height - 4 - (index + 1) * row_h
            label = _fit_text(str(row["label"]), "Helvetica", 7, label_w - 4)
            drawing.add(String(0, y + 3.2, label, fontSize=7, fillColor=_hex(INK)))
            drawing.add(Rect(track_x, y + 1.5, track_w, 5.6, rx=2.8, ry=2.8,
                             fillColor=_hex("#eef1f8"), strokeColor=None))
            span = max(3, track_w * (row["value"] / peak))
            drawing.add(Rect(track_x, y + 1.5, span, 5.6, rx=2.8, ry=2.8,
                             fillColor=_hex(row.get("color") or primary), strokeColor=None))
            drawing.add(String(width, y + 3.2, row.get("display") or _compact(row["value"]),
                               fontSize=7, fillColor=_hex(INK), textAnchor="end"))
        return drawing


def _nice_ceiling(value: float) -> float:
    if value <= 0:
        return 10
    import math

    exponent = math.floor(math.log10(value))
    magnitude = 10 ** exponent
    normalized = value / magnitude
    step = 1 if normalized <= 1 else 2 if normalized <= 2 else 5 if normalized <= 5 else 10
    return step * magnitude


def _compact(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if abs(value) >= 1_000:
        return f"{value / 1_000:.0f}k"
    return f"{value:.0f}"


# --------------------------------------------------------------------------- #
# Palette, typography helpers and small custom flowables
# --------------------------------------------------------------------------- #
def _safe_hex(value, fallback: str):
    from reportlab.lib.colors import HexColor

    text = str(value or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        return HexColor(text)
    if re.fullmatch(r"#[0-9a-fA-F]{3}", text):
        return HexColor("#" + "".join(char * 2 for char in text[1:]))
    return HexColor(fallback)


def _mix(color, other, weight: float = 0.5):
    from reportlab.lib.colors import Color

    return Color(
        color.red + (other.red - color.red) * weight,
        color.green + (other.green - color.green) * weight,
        color.blue + (other.blue - color.blue) * weight,
    )


def _hex_string(color) -> str:
    return "#{:02x}{:02x}{:02x}".format(
        max(0, min(255, round(color.red * 255))),
        max(0, min(255, round(color.green * 255))),
        max(0, min(255, round(color.blue * 255))),
    )


def _luminance(color) -> float:
    def linear(channel: float) -> float:
        return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4

    return (0.2126 * linear(color.red) + 0.7152 * linear(color.green)
            + 0.0722 * linear(color.blue))


def _readable_on(color):
    from reportlab.lib.colors import white

    return white if _luminance(color) < 0.55 else _hex(INK)


def _brand(company):
    branding = ((company.settings or {}).get("branding") or {})
    return (
        _safe_hex(branding.get("primary"), PRIMARY),
        _safe_hex(branding.get("accent"), ACCENT),
    )


def brand_hex(company) -> tuple[str, str]:
    """The company's brand colours as hex strings (for chart series)."""
    primary, accent = _brand(company)
    return _hex_string(primary), _hex_string(accent)


def chart_palette(company, count: int = 6) -> list[str]:
    """A brand-led chart palette that still separates six categories."""
    primary, accent = _brand(company)
    candidates = [
        primary,
        _mix(primary, accent, 0.55),
        accent,
        _mix(primary, _hex("#ffffff"), 0.38),
        _hex(SUCCESS),
        _hex(WARNING),
        _mix(accent, _hex("#ffffff"), 0.35),
    ]
    return [_hex_string(color) for color in candidates[:max(1, count)]]


def _fit_text(text, font: str, size: float, width: float) -> str:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    text = str(text)
    if width <= 1 or stringWidth(text, font, size) <= width:
        return text
    ellipsis = "…"
    while text and stringWidth(text + ellipsis, font, size) > width:
        text = text[:-1]
    return f"{text}{ellipsis}" if text else ""


def _fit_size(text, font: str, sizes, width: float) -> float:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    for size in sizes:
        if stringWidth(str(text), font, size) <= width:
            return size
    return sizes[-1]


def _initials(name: str) -> str:
    parts = [part for part in re.split(r"\s+", (name or "").strip()) if part]
    return "".join(part[0] for part in parts[:2]).upper() or "UP"


def _generated_label(company) -> str:
    now = datetime.now(timezone.utc)
    label = format_local(now, company, "%d %b %Y · %H:%M")
    try:
        abbreviation = now.astimezone(zone_for(company)).strftime("%Z")
    except Exception:
        abbreviation = timezone_name(company)
    return f"{label} {abbreviation}".strip()


def _company_identity(company):
    settings = company.settings or {}
    business = settings.get("business") or {}
    name = business.get("legal_name") or company.name
    identity = "   ·   ".join(bit for bit in (
        f"VAT {business.get('tax_number')}" if business.get("tax_number") else "",
        f"Reg {business.get('company_reg_number')}" if business.get("company_reg_number") else "",
    ) if bit)
    contact = "   ·   ".join(bit for bit in (
        business.get("phone"), business.get("email"), business.get("website"),
    ) if bit)
    address = ", ".join(bit for bit in (
        business.get("address"), business.get("city"), business.get("country"),
    ) if bit)
    return name, identity, contact or address


def _company_logo(company):
    """A raster logo from branding, if the tenant uploaded one ReportLab can read."""
    branding = ((company.settings or {}).get("branding") or {})
    data = str(branding.get("logo_data_url") or "")
    if not data.startswith("data:image/"):
        return None
    header, _, payload = data.partition(",")
    if not any(kind in header.lower() for kind in ("png", "jpeg", "jpg", "webp")):
        return None
    try:
        from reportlab.lib.utils import ImageReader

        return ImageReader(io.BytesIO(base64.b64decode(payload)))
    except Exception:
        return None


class _TrackedText(Flowable):
    """Flowable drawing small uppercase text with letter spacing."""

    def __init__(self, text: str, font: str, size: float, color, char_space: float = 0.9):
        super().__init__()
        self.text = text
        self.font = font
        self.size = size
        self.color = color
        self.char_space = char_space
        self.width = 0
        self.height = size + 2

    def wrap(self, avail_width, avail_height):
        from reportlab.pdfbase.pdfmetrics import stringWidth

        self.width = stringWidth(self.text, self.font, self.size) + self.char_space * max(0, len(self.text) - 1)
        return self.width, self.height

    def draw(self):
        self.canv.setFont(self.font, self.size)
        self.canv.setFillColor(self.color)
        self.canv.drawString(0, 1, self.text, charSpace=self.char_space)


class _SectionTitle(Flowable):
    """Brand square, title, optional note and a hairline underneath."""

    HEIGHT = 18

    def __init__(self, title, width, primary, ink, muted, border, note=""):
        super().__init__()
        self.height = self.HEIGHT
        self.title = title
        self.width = width
        self.primary = primary
        self.ink = ink
        self.muted = muted
        self.border = border
        self.note = note
        self.keepWithNext = 0

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(self.primary)
        canvas.roundRect(0, 9.5, 5, 5, 1.2, stroke=0, fill=1)
        canvas.setFillColor(self.ink)
        canvas.setFont("Helvetica-Bold", 9.2)
        canvas.drawString(11, 8.5, _fit_text(self.title, "Helvetica-Bold", 9.2, self.width - 86))
        if self.note:
            canvas.setFillColor(self.muted)
            canvas.setFont("Helvetica", 6.6)
            canvas.drawRightString(self.width, 8.5, self.note)
        canvas.setStrokeColor(self.border)
        canvas.setLineWidth(0.5)
        canvas.line(0, 1, self.width, 1)


class _Legend(Flowable):
    HEIGHT = 13

    def __init__(self, items, width, muted):
        super().__init__()
        self.height = self.HEIGHT
        self.items = items
        self.width = width
        self.muted = muted

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        from reportlab.pdfbase.pdfmetrics import stringWidth

        canvas = self.canv
        x = 0
        for item in self.items:
            canvas.setFillColor(item["color"])
            canvas.circle(x + 3, 6.5, 2.4, stroke=0, fill=1)
            canvas.setFillColor(self.muted)
            canvas.setFont("Helvetica", 6.6)
            canvas.drawString(x + 9, 4.5, item["name"])
            x += 9 + stringWidth(item["name"], "Helvetica", 6.6) + 16


class _KpiBoard(Flowable):
    CARD_H = 62
    GAP = 8
    PER_ROW = 4

    def __init__(self, kpis, width, primary, border, text, muted, surface):
        super().__init__()
        self.kpis = list(kpis)
        self.width = width
        self.primary = primary
        self.border = border
        self.text = text
        self.muted = muted
        self.surface = surface
        self.rows = [self.kpis[index:index + self.PER_ROW]
                     for index in range(0, len(self.kpis), self.PER_ROW)]
        self.height = len(self.rows) * self.CARD_H + max(0, len(self.rows) - 1) * self.GAP

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        from reportlab.lib.utils import simpleSplit

        canvas = self.canv
        for row_index, row in enumerate(self.rows):
            y = self.height - (row_index + 1) * self.CARD_H - row_index * self.GAP
            columns = max(1, len(row))
            card_width = (self.width - self.GAP * (columns - 1)) / columns
            for index, kpi in enumerate(row):
                x = index * (card_width + self.GAP)
                canvas.setFillColor(self.surface)
                canvas.setStrokeColor(self.border)
                canvas.setLineWidth(0.6)
                canvas.roundRect(x, y, card_width, self.CARD_H, 7, stroke=1, fill=1)

                canvas.setFillColor(self.primary)
                canvas.circle(x + 14, y + self.CARD_H - 17, 2.6, stroke=0, fill=1)
                canvas.setFillColor(self.muted)
                canvas.setFont("Helvetica-Bold", 6.1)
                label = str(kpi.get("label", "")).upper()
                canvas.drawString(x + 21, y + self.CARD_H - 19,
                                  _fit_text(label, "Helvetica-Bold", 6.1, card_width - 32),
                                  charSpace=0.8)

                value = str(kpi.get("value", ""))
                tone = kpi.get("tone") or self.text
                canvas.setFillColor(_safe_hex(tone, INK) if isinstance(tone, str) else tone)
                size = _fit_size(value, "Helvetica-Bold", [13.6, 12.8, 12, 11.2, 10.4, 9.6],
                                 card_width - 24)
                canvas.setFont("Helvetica-Bold", size)
                canvas.drawString(x + 12, y + 27, value)

                hint = str(kpi.get("hint") or "")
                if hint:
                    canvas.setFillColor(self.muted)
                    canvas.setFont("Helvetica", 6.1)
                    lines = simpleSplit(hint, "Helvetica", 6.1, card_width - 24)[:2]
                    for line_index, line in enumerate(lines):
                        canvas.drawString(x + 12, y + 15.5 - line_index * 7.2, line)


class _EmptyPanel(Flowable):
    HEIGHT = 62

    def __init__(self, width, primary, surface, border, ink, muted,
                 message="No records in this period.", hint=""):
        super().__init__()
        self.height = self.HEIGHT
        self.width = width
        self.primary = primary
        self.surface = surface
        self.border = border
        self.ink = ink
        self.muted = muted
        self.message = message
        self.hint = hint

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(self.surface)
        canvas.setStrokeColor(self.border)
        canvas.setLineWidth(0.6)
        canvas.roundRect(0, 0, self.width, self.height, 7, stroke=1, fill=1)
        center = self.width / 2
        canvas.setStrokeColor(self.primary)
        canvas.setLineWidth(1.1)
        canvas.circle(center, 41, 6.5, stroke=1, fill=0)
        canvas.setFillColor(self.primary)
        canvas.circle(center, 41, 2.2, stroke=0, fill=1)
        canvas.setFillColor(self.ink)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.drawCentredString(center, 23, self.message)
        if self.hint:
            canvas.setFillColor(self.muted)
            canvas.setFont("Helvetica", 6.4)
            canvas.drawCentredString(center, 13, self.hint)


class _AccentRule(Flowable):
    def __init__(self, width: float, height: float, color):
        super().__init__()
        self.width = width
        self.height = height
        self.color = color

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(self.color)
        canvas.roundRect(0, 0, self.width, self.height, self.height / 2, stroke=0, fill=1)


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _short_datetime(value) -> str:
    """ISO timestamps become a compact, human date for table cells."""
    text = str(value or "").strip()
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", text)
    if not match:
        return text
    year, month, day, hour, minute = match.groups()
    try:
        label = _MONTHS[int(month) - 1]
    except (ValueError, IndexError):
        return text
    return f"{day} {label} {hour}:{minute}"


def _display_value(value, column, symbol) -> str:
    if column.get("type", "text") == "text" and column.get("key") in {
        "created_at", "date", "updated_at", "opened_at", "closed_at",
    }:
        return _short_datetime(value)
    return _format(value, column.get("type", "text"), symbol)


def _prune_columns(columns, rows):
    """Hide columns that are entirely empty or zero so wide reports stay readable."""
    if len(columns) <= 3 or not rows:
        return columns, rows
    keep = []
    for index, column in enumerate(columns):
        values = [row[index] for row in rows if index < len(row)]
        kind = column.get("type", "text")
        if kind in {"money", "number"} and values:
            try:
                empty = all(abs(float(value or 0)) < 1e-9 for value in values)
            except (TypeError, ValueError):
                empty = False
            if empty:
                continue
        elif kind == "text" and values and all(not str(value or "").strip() for value in values):
            continue
        keep.append(index)
    if len(keep) < 2:
        return columns, rows
    pruned_columns = [columns[index] for index in keep]
    pruned_rows = [[row[index] if index < len(row) else None for index in keep] for row in rows]
    return pruned_columns, pruned_rows


def _totals_row(columns, rows, symbol):
    """Sum the numeric columns so the PDF always ends with a bottom line."""
    totals = []
    for index, column in enumerate(columns):
        kind = column.get("type", "text")
        if kind in {"money", "number"} and column.get("total", True):
            total = 0.0
            ok = True
            for row in rows:
                value = row[index] if index < len(row) else None
                if value in (None, ""):
                    continue
                try:
                    total += float(value)
                except (TypeError, ValueError):
                    ok = False
                    break
            if not ok:
                totals.append("")
            elif kind == "money":
                totals.append(_money(round(total), symbol))
            else:
                totals.append(_number(round(total, 3)))
        elif index == 0:
            totals.append("Totals")
        else:
            totals.append("")
    return totals


def render_report_pdf(
    *,
    company,
    title: str,
    subtitle: str = "",
    period_label: str = "",
    branch_name: str = "",
    columns: list[dict] | None = None,
    rows: list[list] | None = None,
    tables: list[dict] | None = None,
    kpis: list[dict] | None = None,
    charts: list[dict] | None = None,
    footer_note: str = "",
) -> bytes:
    """Render one report to PDF bytes.

    ``rows``/``columns`` print a single table; ``tables`` prints several titled
    tables instead (the summary uses that for its per-branch and per-department
    breakdowns).
    """
    rows = rows or []
    columns = columns or []
    columns, rows = _prune_columns(columns, rows)
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfgen import canvas as pdfcanvas
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.platypus import (CondPageBreak, KeepTogether, Paragraph, SimpleDocTemplate,
                                    Spacer, Table, TableStyle)
    from reportlab.platypus.flowables import HRFlowable

    settings = company.settings or {}
    currency = settings.get("currency") or {}
    symbol = currency.get("symbol", "$")
    company_name, identity, contact = _company_identity(company)
    primary, accent = _brand(company)
    brand_tint = _mix(primary, _hex("#ffffff"), 0.90)
    brand_deep = _mix(primary, _hex("#000000"), 0.26)
    surface = _mix(primary, _hex("#ffffff"), 0.945)
    ink = _hex(INK)
    muted = _hex(MUTED)
    border = _hex(BORDER)
    generated = _generated_label(company)
    logo = _company_logo(company)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
        topMargin=112,
        bottomMargin=54,
        title=f"{title} · {company_name}",
        author=company_name,
        subject=subtitle or title,
        creator="Universal POS",
        keywords=f"Universal POS, {title}, {company_name}",
    )

    title_style = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=22, leading=25,
                                 textColor=ink, spaceBefore=1)
    subtitle_style = ParagraphStyle("subtitle", fontName="Helvetica", fontSize=9.2, leading=12.2,
                                    textColor=muted, spaceBefore=2)
    meta_style = ParagraphStyle("meta", fontName="Helvetica", fontSize=7.1, leading=9.2,
                                textColor=muted, spaceBefore=4)
    note_style = ParagraphStyle("note", fontName="Helvetica-Oblique", fontSize=6.7, leading=9,
                                textColor=muted)
    status_style = ParagraphStyle("status", fontName="Helvetica-Bold", fontSize=6.6, leading=8.2)

    story = [
        _AccentRule(38, 2.6, primary),
        Spacer(1, 7),
        _TrackedText("UNIVERSAL POS  ·  REPORT", "Helvetica-Bold", 6.4, primary, 1.0),
        Spacer(1, 5),
        Paragraph(escape(title), title_style),
    ]
    if subtitle:
        story.append(Paragraph(escape(subtitle), subtitle_style))
    meta_bits = [bit for bit in (
        period_label,
        f"Branch: {branch_name}" if branch_name else "",
        f"Issued {generated}" if generated else "",
    ) if bit]
    if meta_bits:
        story.append(Paragraph("  ·  ".join(escape(bit) for bit in meta_bits), meta_style))
    story.append(Spacer(1, 10))

    # ---- KPI strip ---------------------------------------------------------
    if kpis:
        story.append(_KpiBoard(kpis, CONTENT_WIDTH, primary, border, ink, muted, surface))
        story.append(Spacer(1, 12))

    # ---- charts (max two) --------------------------------------------------
    for chart in (charts or [])[:2]:
        story.append(CondPageBreak(196))
        story.append(_SectionTitle(
            chart.get("title", ""), CONTENT_WIDTH, primary, ink, muted, border,
            chart.get("note", ""),
        ))
        if chart["type"] == "line":
            drawing = _Charts.line(CONTENT_WIDTH, 128, chart["series"], chart["labels"])
            legend = _Legend(
                [{"name": line["name"], "color": line["color"]} for line in chart["series"]],
                CONTENT_WIDTH, muted,
            )
        else:
            drawing = _Charts.bars(
                CONTENT_WIDTH, max(70, min(150, 20 * len(chart["rows"]))),
                chart["rows"], primary=_hex_string(primary),
            )
            legend = Paragraph(escape(chart["legend"]), note_style) if chart.get("legend") else None
        story.append(KeepTogether([drawing] + ([legend] if legend else [])))
        story.append(Spacer(1, 12))

    # ---- table(s) ----------------------------------------------------------
    header_font = 6.4
    cell_font = 7.0
    status_tones = {
        "completed": SUCCESS, "active": SUCCESS, "open": SUCCESS, "settled": SUCCESS,
        "paid": SUCCESS, "refunded": DANGER, "voided": DANGER, "cancelled": DANGER,
        "failed": DANGER, "partial": WARNING, "partially_refunded": WARNING, "pending": WARNING,
    }

    def status_tone(value) -> str:
        key = str(value).strip().lower().replace(" ", "_")
        return status_tones.get(key, INK)

    def build_table(block_columns, block_rows):
        if not block_rows:
            return _EmptyPanel(CONTENT_WIDTH, primary, surface, border, ink, muted)

        minimums = []
        for index, column in enumerate(block_columns):
            header_width = stringWidth(
                str(column["label"]).upper(), "Helvetica-Bold", header_font) + 12
            widths = []
            for row in block_rows[:80]:
                value = _display_value(row[index] if index < len(row) else None,
                                       column, symbol)
                widths.append(stringWidth(str(value), "Helvetica", cell_font))
            content_width = (max(widths) if widths else 42) + 12
            minimums.append(max(header_width, min(content_width, 154)))
            if column.get("type") == "badge":
                minimums[-1] = max(minimums[-1], 50)

        minimum_total = sum(minimums) or 1
        if minimum_total > CONTENT_WIDTH:
            col_widths = [value * CONTENT_WIDTH / minimum_total for value in minimums]
        else:
            spare = CONTENT_WIDTH - minimum_total
            weights = [max(column.get("weight", 1), 1) for column in block_columns]
            weight_total = sum(weights) or 1
            col_widths = [base + spare * (weight / weight_total)
                          for base, weight in zip(minimums, weights)]

        data = [[str(column["label"]).upper() for column in block_columns]]
        for row in block_rows:
            cells = []
            for index, (column, width) in enumerate(zip(block_columns, col_widths)):
                raw = _display_value(row[index] if index < len(row) else None,
                                     column, symbol)
                if column.get("type") == "badge":
                    label_text = escape(str(raw).replace("_", " ").title())
                    cells.append(Paragraph(
                        f'<font color="{status_tone(raw)}">{label_text}</font>', status_style))
                else:
                    cells.append(_fit_text(raw, "Helvetica", cell_font, width - 12))
            data.append(cells)

        numeric_align = [
            "RIGHT" if column.get("type") in {"money", "number", "percent"} else "LEFT"
            for column in block_columns
        ]
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), brand_tint),
            ("TEXTCOLOR", (0, 0), (-1, 0), brand_deep),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), header_font),
            ("FONTSIZE", (0, 1), (-1, -1), cell_font),
            ("TEXTCOLOR", (0, 1), (-1, -1), ink),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, 0), 5.6),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5.6),
            ("TOPPADDING", (0, 1), (-1, -1), 3.6),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 3.6),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("LINEBELOW", (0, 0), (-1, 0), 0.9, primary),
        ]
        if len(data) > 2:
            style.append(("LINEBELOW", (0, 1), (-1, -2), 0.35, _hex("#edf0f6")))
        for index, align in enumerate(numeric_align):
            style.append(("ALIGN", (index, 0), (index, -1), align))
        for index in range(1, len(data) - 1):
            if index % 2 == 0:
                style.append(("BACKGROUND", (0, index), (-1, index), _hex("#fbfcfe")))

        totals = _totals_row(block_columns, block_rows, symbol)
        data.append([_fit_text(value, "Helvetica-Bold", cell_font, width - 12)
                     for value, width in zip(totals, col_widths)])
        style += [
            ("BACKGROUND", (0, -1), (-1, -1), brand_tint),
            ("LINEABOVE", (0, -1), (-1, -1), 0.9, primary),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("TEXTCOLOR", (0, -1), (-1, -1), brand_deep),
        ]

        table = Table(data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle(style))
        return table

    if tables:
        for index, section in enumerate(tables):
            section_columns, section_rows = _prune_columns(
                section["columns"], section.get("rows") or [])
            row_label = f"{len(section_rows):,} row" if len(section_rows) == 1 else f"{len(section_rows):,} rows"
            story.append(CondPageBreak(72))
            story.append(_SectionTitle(
                section.get("title", ""), CONTENT_WIDTH, primary, ink, muted, border,
                row_label if section_rows else "",
            ))
            story.append(build_table(section_columns, section_rows))
            if index < len(tables) - 1:
                story.append(Spacer(1, 14))
    elif columns:
        row_label = f"{len(rows):,} row" if len(rows) == 1 else f"{len(rows):,} rows"
        story.append(CondPageBreak(72))
        story.append(_SectionTitle(
            "Details", CONTENT_WIDTH, primary, ink, muted, border,
            row_label if rows else "",
        ))
        story.append(build_table(columns, rows))

    if footer_note:
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width="100%", thickness=0.5, color=border, spaceBefore=0, spaceAfter=4))
        story.append(Paragraph(
            f'<font color="{_hex_string(primary)}">•</font>  {escape(footer_note)}',
            note_style,
        ))

    # ---- page furniture ----------------------------------------------------
    def draw_furniture(canvas, page_number: int, total_pages: int):
        canvas.saveState()
        width, height = A4

        # A disciplined top edge: brand colour, closed by the accent.
        canvas.setStrokeColor(primary)
        canvas.setLineWidth(2.4)
        canvas.line(0, height - 1.2, width, height - 1.2)
        canvas.setStrokeColor(accent)
        canvas.line(width * 0.72, height - 1.2, width, height - 1.2)

        mark_size = 34
        mark_x, mark_y = MARGIN_X, height - 60
        mark_image = logo
        if mark_image is not None:
            try:
                canvas.saveState()
                clip = canvas.beginPath()
                clip.roundRect(mark_x, mark_y, mark_size, mark_size, 8)
                canvas.clipPath(clip, stroke=0, fill=0)
                canvas.drawImage(mark_image, mark_x, mark_y, mark_size, mark_size,
                                 mask="auto", preserveAspectRatio=True)
                canvas.restoreState()
                canvas.setStrokeColor(_mix(primary, _hex("#ffffff"), 0.78))
                canvas.setLineWidth(0.6)
                canvas.roundRect(mark_x, mark_y, mark_size, mark_size, 8, stroke=1, fill=0)
            except Exception:
                mark_image = None
        if mark_image is None:
            canvas.setFillColor(primary)
            canvas.roundRect(mark_x, mark_y, mark_size, mark_size, 8, stroke=0, fill=1)
            canvas.setFillColor(_readable_on(primary))
            canvas.setFont("Helvetica-Bold", 11.5)
            canvas.drawCentredString(mark_x + mark_size / 2, mark_y + 11,
                                     _initials(company_name))

        text_x = mark_x + mark_size + 12
        text_width = max(110, width / 2 - text_x - 20)
        canvas.setFillColor(ink)
        canvas.setFont("Helvetica-Bold", 12.5)
        canvas.drawString(text_x, height - 38,
                          _fit_text(company_name, "Helvetica-Bold", 12.5, text_width))
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 7.1)
        canvas.drawString(text_x, height - 49,
                          _fit_text(identity or "Point of sale", "Helvetica", 7.1, text_width))
        if contact:
            contact_width = max(110, width / 2 - text_x - 20)
            contact_parts = contact.split("   ·   ")
            for offset, chunk in enumerate((contact_parts[:2], contact_parts[2:])):
                if chunk:
                    canvas.drawString(text_x, height - 59 - offset * 9,
                                      _fit_text("   ·   ".join(chunk), "Helvetica", 7.1,
                                                contact_width))

        right = width - MARGIN_X
        right_width = 236
        canvas.setFillColor(primary)
        canvas.setFont("Helvetica-Bold", 6.1)
        canvas.drawRightString(right, height - 34, "REPORT", charSpace=0.9)
        canvas.setFillColor(ink)
        canvas.setFont("Helvetica-Bold", 9.2)
        canvas.drawRightString(right, height - 46,
                               _fit_text(title.upper(), "Helvetica-Bold", 9.2, right_width))
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 7.1)
        if period_label:
            canvas.drawRightString(right, height - 57,
                                   _fit_text(period_label, "Helvetica", 7.1, right_width))
        canvas.drawRightString(right, height - 67,
                               _fit_text(generated, "Helvetica", 7.1, right_width))

        canvas.setStrokeColor(border)
        canvas.setLineWidth(0.6)
        canvas.line(MARGIN_X, height - 78, width - MARGIN_X, height - 78)

        canvas.line(MARGIN_X, 44, width - MARGIN_X, 44)
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 6.6)
        canvas.drawString(MARGIN_X, 32,
                          _fit_text(f"{company_name}  ·  Universal POS", "Helvetica", 6.6, 300))
        canvas.drawCentredString(width / 2, 32, "Confidential")
        if total_pages > 1:
            canvas.drawRightString(right, 32, f"Page {page_number} of {total_pages}")
        canvas.restoreState()

    class _FurnitureCanvas(pdfcanvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for index, state in enumerate(self._saved_page_states):
                self.__dict__.update(state)
                draw_furniture(self, index + 1, total)
                pdfcanvas.Canvas.showPage(self)
            pdfcanvas.Canvas.save(self)

    doc.build(story, canvasmaker=_FurnitureCanvas)
    return buffer.getvalue()


def render_summary_pdf(*, company, data, start_label, end_label, branch_name="") -> bytes:
    """The Reports → Summary dashboard as a PDF: totals, trend and who sold what.

    A summary aggregates — daily rows belong to the Sales report. The tables
    break the period down by branch and by department instead.
    """
    settings = company.settings or {}
    symbol = (settings.get("currency") or {}).get("symbol", "$")
    primary_hex, _ = brand_hex(company)
    palette = chart_palette(company)
    cards = data.get("cards") or {}
    sales_cents = int(cards.get("sales_cents") or 0)
    profit_cents = int(cards.get("gross_profit_cents") or 0)
    margin = (profit_cents / sales_cents * 100) if sales_cents else 0

    kpis = [
        {"label": "Net sales", "value": _money(sales_cents, symbol),
         "hint": f"{_number(cards.get('transactions'))} transactions"},
        {"label": "Gross profit", "value": _money(profit_cents, symbol),
         "hint": f"{margin:.1f}% margin · cost {_money(cards.get('cost_cents'), symbol)}",
         "tone": SUCCESS if profit_cents >= 0 else DANGER},
        {"label": "Average ticket", "value": _money(cards.get("average_ticket_cents"), symbol),
         "hint": f"{_number(cards.get('items_sold'))} items sold"},
        {"label": "Tax collected", "value": _money(cards.get("tax_cents"), symbol),
         "hint": f"{_money(cards.get('discount_cents'), symbol)} discounts · "
                 f"{_money(cards.get('refunded_cents'), symbol)} refunds"},
    ]

    series = data.get("series") or []
    labels = [row["date"][5:] for row in series]
    revenue = [round((row.get("sales_cents") or 0) / 100) for row in series]
    profit = [round((row.get("profit_cents") or (row.get("sales_cents") or 0) - (row.get("cost_cents") or 0)) / 100)
              for row in series]
    charts = []
    if series:
        charts.append({
            "type": "line",
            "title": "Revenue and profit",
            "labels": labels,
            "series": [
                {"name": "Revenue", "color": primary_hex, "values": revenue},
                {"name": "Profit", "color": SUCCESS, "values": profit},
            ],
        })

    mix = data.get("payment_mix") or []
    if mix:
        charts.append({
            "type": "bar",
            "title": "Collected by payment method",
            "rows": [
                {
                    "label": row["name"],
                    "value": row.get("amount_cents") or 0,
                    "display": _money(row.get("amount_cents"), symbol),
                    "color": palette[index % len(palette)],
                }
                for index, row in enumerate(mix[:6])
            ],
        })

    tables = []

    comparison = data.get("comparison") or {}
    if comparison.get("current"):
        current = comparison["current"]
        rows = [["Selected period", current.get("revenue_cents") or 0,
                 current.get("profit_cents") or 0, None]]
        previous = comparison.get("previous") or {}
        if previous:
            rows.append([previous.get("label") or "Previous period",
                         previous.get("revenue_cents") or 0,
                         previous.get("profit_cents") or 0,
                         -previous.get("change_percent") if previous.get("change_percent") is not None else None])
        for key in ("best", "worst"):
            row = comparison.get(key) or {}
            if row:
                rows.append([
                    f"{key.title()} {comparison.get('unit_label') or 'period'} · {row.get('label')}",
                    row.get("revenue_cents") or 0,
                    row.get("profit_cents") or 0,
                    row.get("vs_current_percent"),
                ])
        tables.append({
            "title": "How this period compares",
            "columns": [
                {"key": "period", "label": "Period", "type": "text", "weight": 2.1},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
                {"key": "profit", "label": "Profit", "type": "money", "weight": 1.1},
                {"key": "change", "label": "vs selected", "type": "percent", "weight": 0.8},
            ],
            "rows": rows,
        })

    branches = data.get("branches") or []
    if branches:
        tables.append({
            "title": "Sales by branch",
            "columns": [
                {"key": "branch", "label": "Branch", "type": "text", "weight": 1.6},
                {"key": "transactions", "label": "Sales", "type": "number", "weight": 0.6},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
                {"key": "cost", "label": "Cost", "type": "money", "weight": 1.1},
                {"key": "profit", "label": "Profit", "type": "money", "weight": 1.1},
                {"key": "share", "label": "Share", "type": "percent", "weight": 0.6},
            ],
            "rows": [
                [
                    row["name"],
                    row.get("transactions") or 0,
                    row.get("sales_cents") or 0,
                    row.get("cost_cents") or 0,
                    row.get("profit_cents") or 0,
                    round((row.get("sales_cents") or 0) / sales_cents * 100, 1) if sales_cents else 0,
                ]
                for row in branches
            ],
        })

    team = data.get("team") or []
    if team:
        tables.append({
            "title": "Sales by user",
            "columns": [
                {"key": "user", "label": "User", "type": "text", "weight": 1.7},
                {"key": "transactions", "label": "Sales", "type": "number", "weight": 0.6},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
                {"key": "profit", "label": "Profit", "type": "money", "weight": 1.1},
                {"key": "share", "label": "Share", "type": "percent", "weight": 0.6},
            ],
            "rows": [
                [
                    row["name"],
                    row.get("transactions") or 0,
                    row.get("sales_cents") or 0,
                    row.get("profit_cents") or 0,
                    row.get("share_percent") or 0,
                ]
                for row in team
            ],
        })

    departments = data.get("department_mix") or []
    if departments:
        tables.append({
            "title": "Sales by department",
            "columns": [
                {"key": "department", "label": "Department", "type": "text", "weight": 1.6},
                {"key": "qty", "label": "Units", "type": "number", "weight": 0.6},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
                {"key": "cost", "label": "Cost", "type": "money", "weight": 1.1},
                {"key": "profit", "label": "Profit", "type": "money", "weight": 1.1},
                {"key": "share", "label": "Share", "type": "percent", "weight": 0.6},
            ],
            "rows": [
                [
                    row["name"],
                    row.get("qty") or 0,
                    row.get("revenue_cents") or 0,
                    row.get("cost_cents") or 0,
                    row.get("profit_cents") or 0,
                    round((row.get("revenue_cents") or 0) / sales_cents * 100, 1) if sales_cents else 0,
                ]
                for row in departments
            ],
        })

    top_products = data.get("top_products") or []
    if top_products:
        tables.append({
            "title": "Top 3 products",
            "columns": [
                {"key": "product", "label": "Product", "type": "text", "weight": 1.8},
                {"key": "qty", "label": "Units", "type": "number", "weight": 0.6},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
            ],
            "rows": [[row.get("name"), row.get("qty") or 0, row.get("revenue_cents") or 0]
                     for row in top_products[:3]],
        })

    least_products = data.get("least_products") or []
    if least_products:
        tables.append({
            "title": "Watchlist · lowest 3",
            "columns": [
                {"key": "product", "label": "Product", "type": "text", "weight": 1.8},
                {"key": "qty", "label": "Units", "type": "number", "weight": 0.6},
                {"key": "revenue", "label": "Revenue", "type": "money", "weight": 1.1},
            ],
            "rows": [[row.get("name"), row.get("qty") or 0, row.get("revenue_cents") or 0]
                     for row in least_products[:3]],
        })

    return render_report_pdf(
        company=company,
        title="Sales summary",
        subtitle="Totals, trend and performance by branch and department",
        period_label=f"{start_label} → {end_label}",
        branch_name=branch_name,
        tables=tables,
        kpis=kpis,
        charts=charts,
        footer_note="Profit is net revenue minus the recorded buying price of the goods sold. "
                    "Day-by-day detail lives in the Sales report.",
    )


def render_layby_statement_pdf(*, company, layby) -> bytes:
    """A lay-by agreement/statement: what was reserved, what is paid, what is due."""
    settings = company.settings or {}
    symbol = (settings.get("currency") or {}).get("symbol", "$")
    status = {"active": "Active", "completed": "Settled", "cancelled": "Cancelled"}.get(
        layby.status, str(layby.status).title()
    )
    outstanding = int(layby.balance_cents or 0)
    kpis = [
        {"label": "Lay-by total", "value": _money(layby.total_cents, symbol),
         "hint": status},
        {"label": "Paid to date", "value": _money(layby.paid_cents, symbol),
         "hint": f"{len(layby.payments)} payment{'' if len(layby.payments) == 1 else 's'}",
         "tone": SUCCESS},
        {"label": "Balance due", "value": _money(outstanding, symbol),
         "hint": "Settled in full" if outstanding <= 0 else "Still to pay",
         "tone": DANGER if outstanding > 0 else SUCCESS},
        {"label": "Due date",
         "value": format_local(layby.due_date, company, "%d %b %Y") or "—",
         "hint": "Opened " + (format_local(layby.created_at, company, "%d %b %Y") or "—")},
    ]

    def payment_rows():
        return [
            [
                format_local(payment.created_at, company, "%d %b %Y %H:%M"),
                payment.method_name or "—",
                payment.reference or "",
                int(payment.amount_cents or 0),
            ]
            for payment in layby.payments
        ]

    tables = [
        {
            "title": "Goods reserved",
            "columns": [
                {"key": "item", "label": "Item", "type": "text", "weight": 2.2},
                {"key": "sku", "label": "SKU", "type": "text", "weight": 1},
                {"key": "qty", "label": "Qty", "type": "number", "weight": 0.6},
                {"key": "price", "label": "Price", "type": "money", "weight": 1},
                {"key": "amount", "label": "Amount", "type": "money", "weight": 1},
            ],
            "rows": [
                [item.name, item.sku or "", float(item.qty or 0), int(item.unit_price_cents or 0),
                 int(item.line_total_cents or 0)]
                for item in layby.items
            ],
        },
        {
            "title": "Payments received",
            "columns": [
                {"key": "when", "label": "When", "type": "text", "weight": 1.3},
                {"key": "method", "label": "Method", "type": "text", "weight": 1},
                {"key": "reference", "label": "Reference", "type": "text", "weight": 1.4},
                {"key": "amount", "label": "Amount", "type": "money", "weight": 1},
            ],
            "rows": payment_rows(),
        },
    ]

    customer = layby.customer
    subtitle = f"{layby.number} · {customer.name if customer else 'Walk-in'}"
    if customer and customer.phone:
        subtitle += f" · {customer.phone}"

    return render_report_pdf(
        company=company,
        title="Lay-by statement",
        subtitle=subtitle,
        period_label=f"Opened {format_local(layby.created_at, company, '%d %b %Y')} → "
                     f"Due {format_local(layby.due_date, company, '%d %b %Y')}",
        tables=tables,
        kpis=kpis,
        footer_note=f"Status: {status}. Goods remain the property of the company until paid in full.",
    )
