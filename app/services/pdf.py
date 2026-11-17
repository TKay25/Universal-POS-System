"""Elegant, fast PDF exports for reports.

Uses ReportLab (pure Python, no browser engine) so a month of sales exports in
well under a second. Layout: branded header, KPI strip, up to two charts and a
zebra table with a totals row, then page-numbered footer.
"""

from __future__ import annotations

import io
from datetime import datetime, timezone

from app.services.timezones import format_local, local_today, zone_for

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


class _Charts:
    """Hand-drawn SVG-like charts sized for a portrait page (max two)."""

    @staticmethod
    def line(width, height, series, labels, max_points=14):
        from reportlab.graphics.shapes import Circle, Drawing, Line, PolyLine, Rect, String

        drawing = Drawing(width, height)
        left, right, top, bottom = 44, 8, 10, 20
        plot_w = width - left - right
        plot_h = height - top - bottom
        values = [v for line in series for v in line["values"]]
        peak = max(values) if values else 1
        peak = peak if peak > 0 else 1
        ceiling = _nice_ceiling(peak)

        drawing.add(Rect(0, 0, width, height, fillColor=None, strokeColor=None))
        for step in range(5):
            value = ceiling * step / 4
            y = bottom + plot_h * (step / 4)
            drawing.add(Line(left, y, width - right, y, strokeColor=_hex(BORDER), strokeWidth=0.6,
                             strokeDashArray=[2, 3]))
            drawing.add(String(left - 6, y - 3, _compact(value), fontSize=6.4, fillColor=_hex(MUTED),
                               textAnchor="end"))

        count = max(len(labels), 1)
        stride = max(1, count // max_points)
        def x_for(index):
            return left + (plot_w / 2 if count == 1 else (index / (count - 1)) * plot_w)

        for line in series:
            points = []
            for index, value in enumerate(line["values"]):
                points.extend([x_for(index), bottom + plot_h * (value / ceiling)])
            if len(points) >= 4:
                drawing.add(PolyLine(points, strokeColor=_hex(line["color"]), strokeWidth=1.9,
                                     strokeLineJoin=1, strokeLineCap=1))
                for index in range(0, count, stride):
                    if index * 2 + 1 < len(points):
                        drawing.add(Circle(points[index * 2], points[index * 2 + 1], 1.7,
                                           fillColor=_hex(line["color"]), strokeColor=None))

        for index in range(0, count, stride):
            drawing.add(String(x_for(index), 6, labels[index], fontSize=6.2, fillColor=_hex(MUTED),
                               textAnchor="middle"))
        return drawing

    @staticmethod
    def bars(width, height, rows, max_rows=6):
        from reportlab.graphics.shapes import Drawing, Rect, String

        drawing = Drawing(width, height)
        label_w = 118
        value_w = 68
        track_x = label_w + 6
        track_w = max(30, width - track_x - value_w)
        peak = max([row["value"] for row in rows] or [1]) or 1
        row_h = min(17, max(11, (height - 6) / max(len(rows), 1)))
        for index, row in enumerate(rows[:max_rows]):
            y = height - 6 - (index + 1) * row_h
            label = str(row["label"])
            if len(label) > 22:
                label = label[:21] + "…"
            drawing.add(String(0, y + 3, label, fontSize=7, fillColor=_hex(INK)))
            drawing.add(Rect(track_x, y + 1, track_w, 6.4, rx=3, ry=3, fillColor=_hex(SURFACE),
                             strokeColor=None))
            span = max(4, track_w * (row["value"] / peak))
            drawing.add(Rect(track_x, y + 1, span, 6.4, rx=3, ry=3,
                             fillColor=_hex(row.get("color") or PRIMARY), strokeColor=None))
            drawing.add(String(width, y + 3, row.get("display") or _compact(row["value"]), fontSize=7,
                               fillColor=_hex(INK), textAnchor="end"))
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
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table,
                                    TableStyle)

    settings = company.settings or {}
    business = settings.get("business") or {}
    currency = settings.get("currency") or {}
    symbol = currency.get("symbol", "$")
    company_name = business.get("legal_name") or company.name
    vat = business.get("tax_number") or ""
    reg = business.get("company_reg_number") or ""
    generated = format_local(datetime.now(timezone.utc), company, "%d %b %Y · %H:%M") + " CAT"

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
        topMargin=104,
        bottomMargin=52,
        title=f"{title} · {company_name}",
        author=company_name,
        subject=subtitle or title,
        creator="Universal POS",
    )

    heading = ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=16, leading=19,
                             textColor=_hex(INK), spaceAfter=2)
    sub_style = ParagraphStyle("sub", fontName="Helvetica", fontSize=8.6, leading=11,
                               textColor=_hex(MUTED))

    story = [Paragraph(title, heading)]
    if subtitle:
        story.append(Paragraph(subtitle, sub_style))
    meta_bits = [bit for bit in (period_label, f"Branch: {branch_name}" if branch_name else "",
                                 f"Issued {generated}") if bit]
    if meta_bits:
        story.append(Spacer(1, 3))
        story.append(Paragraph(" · ".join(meta_bits), sub_style))
    story.append(Spacer(1, 12))

    # ---- KPI strip ---------------------------------------------------------
    if kpis:
        cells = []
        for kpi in kpis:
            cell = [[Paragraph(f'<font size="6.4" color="{MUTED}">{kpi["label"].upper()}</font>',
                               ParagraphStyle("k", fontName="Helvetica", fontSize=6.4, leading=8))],
                    [Paragraph(f'<b>{kpi["value"]}</b>',
                               ParagraphStyle("v", fontName="Helvetica-Bold", fontSize=11.5, leading=14,
                                              textColor=_hex(kpi.get("tone") or INK)))],
                    [Paragraph(kpi.get("hint", "") or " ",
                               ParagraphStyle("h", fontName="Helvetica", fontSize=6.2, leading=8,
                                              textColor=_hex(MUTED)))]]
            cells.append(cell)
        per_row = min(len(cells), 4)
        grid = [cells[i:i + per_row] for i in range(0, len(cells), per_row)]
        while len(grid[-1]) < per_row:
            grid[-1].append([["", "", ""]])
        width = CONTENT_WIDTH / per_row
        kpi_table = Table(
            [[Table(cell, colWidths=[width - 12]) for cell in row] for row in grid],
            colWidths=[width] * per_row,
        )
        kpi_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), _hex(SURFACE)),
            ("BOX", (0, 0), (-1, -1), 0.6, _hex(BORDER)),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, _hex(BORDER)),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(kpi_table)
        story.append(Spacer(1, 14))

    # ---- charts (max two) --------------------------------------------------
    for chart in (charts or [])[:2]:
        block_heading = ParagraphStyle("ch", fontName="Helvetica-Bold", fontSize=8.4, leading=10,
                                       textColor=_hex(INK), spaceAfter=4)
        if chart["type"] == "line":
            drawing = _Charts.line(CONTENT_WIDTH, 138, chart["series"], chart["labels"])
            legend = "   ".join(
                f'<font color="{line["color"]}">■</font> {line["name"]}' for line in chart["series"]
            )
        else:
            drawing = _Charts.bars(CONTENT_WIDTH, max(70, min(150, 20 * len(chart["rows"]))), chart["rows"])
            legend = chart.get("legend", "")
        parts = [Paragraph(chart["title"], block_heading), drawing]
        if legend:
            parts.append(Paragraph(legend, ParagraphStyle("lg", fontName="Helvetica", fontSize=6.8,
                                                          leading=9, textColor=_hex(MUTED))))
        parts.append(Spacer(1, 12))
        story.append(KeepTogether(parts))

    # ---- table(s) ----------------------------------------------------------
    header_font = 6.8
    cell_font = 7

    def build_table(block_columns, block_rows):
        """Fit headers and typical cell values, then scale into the page width."""
        minimums = []
        for column in block_columns:
            header_min = len(str(column["label"])) * header_font * 0.62 + 10
            content_min = column.get("weight", 6) * cell_font * 0.52 + 10
            minimums.append(max(header_min, content_min))
        minimum_total = sum(minimums) or 1
        if minimum_total > CONTENT_WIDTH:
            col_widths = [value * CONTENT_WIDTH / minimum_total for value in minimums]
        else:
            spare = CONTENT_WIDTH - minimum_total
            weights = [max(column.get("weight", 1), 1) for column in block_columns]
            weight_total = sum(weights) or 1
            col_widths = [base + spare * (weight / weight_total) for base, weight in zip(minimums, weights)]

        def clip(value: str, width_pt: float, font_size: float = cell_font) -> str:
            # Helvetica averages ~0.52em per glyph; keep text inside its column.
            capacity = max(3, int(width_pt / (font_size * 0.54)))
            text = str(value)
            return f"{text[:capacity - 1]}…" if len(text) > capacity else text

        data = [[str(column["label"]).upper() for column in block_columns]]
        for row in block_rows:
            data.append([
                clip(_format(row[index] if index < len(row) else None, column.get("type", "text"), symbol),
                     width)
                for index, (column, width) in enumerate(zip(block_columns, col_widths))
            ])

        numeric_align = [
            ("RIGHT" if column.get("type") in {"money", "number", "percent"} else "LEFT")
            for column in block_columns
        ]
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), _hex(PRIMARY)),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("FONTSIZE", (0, 0), (-1, 0), 6.8),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 3.4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.4),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, 0), (-1, -2), 0.4, _hex(BORDER)),
            ("BOX", (0, 0), (-1, -1), 0.6, _hex(BORDER)),
        ]
        for index, align in enumerate(numeric_align):
            style.append(("ALIGN", (index, 0), (index, -1), align))
        for index in range(1, len(data)):
            if index % 2 == 0:
                style.append(("BACKGROUND", (0, index), (-1, index), _hex("#fbfcfe")))

        if block_rows:
            totals = _totals_row(block_columns, block_rows, symbol)
            data.append([clip(value, width, 7) for value, width in zip(totals, col_widths)])
            style += [
                ("BACKGROUND", (0, -1), (-1, -1), _hex("#eef0fb")),
                ("LINEABOVE", (0, -1), (-1, -1), 0.8, _hex(PRIMARY)),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ]

        table = Table(data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle(style))
        return table

    block_title = ParagraphStyle("bt", fontName="Helvetica-Bold", fontSize=8.4, leading=10,
                                 textColor=_hex(INK), spaceAfter=4)
    if tables:
        for section in tables:
            story.append(Paragraph(section.get("title", ""), block_title))
            story.append(build_table(section["columns"], section["rows"]))
            story.append(Spacer(1, 14))
    elif columns:
        story.append(build_table(columns, rows))

    if not tables and not rows:
        story.append(Paragraph("No records in this period.", sub_style))

    if footer_note:
        story.append(Spacer(1, 10))
        story.append(Paragraph(footer_note, ParagraphStyle("fn", fontName="Helvetica-Oblique",
                                                           fontSize=6.6, leading=8.4,
                                                           textColor=_hex(MUTED))))

    # ---- page furniture ----------------------------------------------------
    def draw_page(canvas, document):
        canvas.saveState()
        height = A4[1]
        # Header band
        canvas.setFillColor(_hex(PRIMARY))
        canvas.rect(0, height - 74, A4_WIDTH, 74, stroke=0, fill=1)
        canvas.setFillColor(_hex(ACCENT))
        canvas.rect(0, height - 77, A4_WIDTH, 3, stroke=0, fill=1)

        initials = "".join(part[0] for part in company_name.split()[:2]).upper() or "UP"
        canvas.setFillColor(colors.white)
        canvas.roundRect(MARGIN_X, height - 56, 30, 30, 8, stroke=0, fill=1)
        canvas.setFillColor(_hex(PRIMARY))
        canvas.setFont("Helvetica-Bold", 12)
        canvas.drawCentredString(MARGIN_X + 15, height - 46, initials)

        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 12.5)
        canvas.drawString(MARGIN_X + 40, height - 36, company_name[:52])
        canvas.setFont("Helvetica", 7.6)
        canvas.setFillColor(colors.Color(1, 1, 1, 0.78))
        identity = "  ·  ".join(bit for bit in (f"VAT {vat}" if vat else "", f"Reg {reg}" if reg else "") if bit)
        canvas.drawString(MARGIN_X + 40, height - 47, identity or "Point of sale")
        canvas.drawString(MARGIN_X + 40, height - 58, business.get("phone") or business.get("email") or "")

        canvas.setFont("Helvetica-Bold", 9)
        canvas.setFillColor(colors.white)
        canvas.drawRightString(A4_WIDTH - MARGIN_X, height - 36, "UNIVERSAL POS REPORT")
        canvas.setFont("Helvetica", 7.6)
        canvas.setFillColor(colors.Color(1, 1, 1, 0.78))
        canvas.drawRightString(A4_WIDTH - MARGIN_X, height - 47, period_label[:64])
        canvas.drawRightString(A4_WIDTH - MARGIN_X, height - 58, generated)

        # Footer
        canvas.setStrokeColor(_hex(BORDER))
        canvas.setLineWidth(0.6)
        canvas.line(MARGIN_X, 40, A4_WIDTH - MARGIN_X, 40)
        canvas.setFont("Helvetica", 6.8)
        canvas.setFillColor(_hex(MUTED))
        canvas.drawString(MARGIN_X, 28, f"{company_name} — generated by Universal POS")
        canvas.drawRightString(A4_WIDTH - MARGIN_X, 28, f"Page {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)
    return buffer.getvalue()


def render_summary_pdf(*, company, data, start_label, end_label, branch_name="") -> bytes:
    """The Reports → Summary dashboard as a PDF: totals, trend and who sold what.

    A summary aggregates — daily rows belong to the Sales report. The tables
    break the period down by branch and by department instead.
    """
    settings = company.settings or {}
    symbol = (settings.get("currency") or {}).get("symbol", "$")
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
                {"name": "Revenue", "color": PRIMARY, "values": revenue},
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
                    "color": PRIMARY if index % 2 == 0 else ACCENT,
                }
                for index, row in enumerate(mix[:6])
            ],
        })

    tables = []

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
