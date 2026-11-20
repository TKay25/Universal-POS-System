"""Receipt rendering.

Produces a self-contained HTML document (no external assets) that prints cleanly
on 80mm/58mm thermal printers or A4. Barcodes are generated as inline SVG using a
pure-Python Code 128 encoder, so no native imaging libraries are required.
"""

from __future__ import annotations

import html
from collections import OrderedDict
from datetime import datetime

from app.modules import MODULE_BY_KEY

# Code 128 bar/space width patterns for values 0-106 (106 = STOP).
_CODE128 = (
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
    "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
    "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
    "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
    "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
    "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
    "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
    "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
    "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
    "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
    "211214", "211232", "2331112",
)


def barcode_svg(data: str, *, height: int = 46, module: float = 1.7, quiet: int = 10) -> str:
    """Render ``data`` as an inline Code 128 SVG.

    Characters outside printable ASCII are dropped; an empty result yields an
    empty string so the caller can omit the block entirely.
    """
    text = "".join(ch for ch in (data or "") if 32 <= ord(ch) <= 126)
    if not text:
        return ""

    values = [ord(ch) - 32 for ch in text]
    checksum = (104 + sum(v * (i + 1) for i, v in enumerate(values))) % 103
    sequence = [104, *values, checksum, 106]

    bars: list[tuple[int, int]] = []  # (start module, width modules)
    cursor = quiet
    for value in sequence:
        pattern = _CODE128[value]
        for index, char in enumerate(pattern):
            width = int(char)
            if index % 2 == 0:
                bars.append((cursor, width))
            cursor += width
    total_modules = cursor + quiet
    width_px = round(total_modules * module, 2)

    rects = "".join(
        f'<rect x="{round(start * module, 2)}" y="0" width="{round(width * module, 2)}" height="{height}" />'
        for start, width in bars
    )
    return (
        f'<svg class="barcode" xmlns="http://www.w3.org/2000/svg" width="{width_px}" height="{height}" '
        f'viewBox="0 0 {width_px} {height}" role="img" aria-label="Barcode {html.escape(text)}">'
        f'<g fill="#000">{rects}</g></svg>'
    )


def qr_svg(data: str) -> str:
    """Optional QR code. Falls back to nothing when the encoder is unavailable."""
    try:  # pragma: no cover - depends on optional dependency
        import qrcode
        import qrcode.image.svg
    except Exception:
        return ""

    try:  # pragma: no cover
        factory = qrcode.image.svg.SvgPathImage
        img = qrcode.make(data, image_factory=factory, box_size=8, border=1)
        buffer = __import__("io").BytesIO()
        img.save(buffer)
        return buffer.getvalue().decode("utf-8")
    except Exception:
        return ""


def money(cents: int | None, settings: dict) -> str:
    currency = settings.get("currency", {})
    symbol = currency.get("symbol", "")
    decimals = int(currency.get("decimals", 2) or 2)
    value = float(cents or 0) / 100
    negative = value < 0
    amount = f"{abs(value):,.{decimals}f}"
    if currency.get("position", "before") == "after":
        body = f"{amount} {symbol}".strip()
    else:
        body = f"{symbol}{amount}".strip()
    return f"-{body}" if negative else body


def _e(value) -> str:
    return html.escape(str(value if value is not None else ""))


def _dt(value: datetime | None, company=None) -> str:
    if not value:
        return ""
    from app.services.timezones import format_local

    return format_local(value, company)


TEMPLATE_CSS = {
    "thermal": """
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #f4f4f6; font-family: "DejaVu Sans Mono", ui-monospace, "Courier New", monospace; }
    .sheet { width: 80mm; min-height: 100mm; margin: 12px auto; background: #fff; padding: 6mm 5mm 8mm; color: #111; font-size: 11.5px; line-height: 1.45; box-shadow: 0 8px 30px rgba(15, 23, 42, .18); }
    .brand { text-align: center; margin-bottom: 8px; }
    .brand img { max-width: 46mm; max-height: 18mm; object-fit: contain; }
    .brand h1 { font-size: 16px; margin: 4px 0 2px; letter-spacing: .06em; text-transform: uppercase; }
    .brand p { margin: 1px 0; font-size: 10.5px; color: #333; }
    .rule { border-top: 1px dashed #444; margin: 8px 0; }
    .meta { display: flex; justify-content: space-between; font-size: 10.5px; gap: 8px; }
    .meta table { border-collapse: collapse; font-size: 10.5px; }
    .meta td { padding: 0 0 1px; vertical-align: top; }
    .meta td:first-child { color: #444; padding-right: 6px; white-space: nowrap; }
    table.items { width: 100%; border-collapse: collapse; font-size: 10.8px; }
    table.items th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid #111; padding-bottom: 3px; }
    table.items th.num, table.items td.num { text-align: right; }
    table.items td { padding: 3px 0; vertical-align: top; border-bottom: 1px dotted #ccc; }
    .item-name { font-weight: 600; }
    .item-note { font-size: 9.5px; color: #555; font-style: italic; }
    .totals { margin-top: 8px; width: 100%; border-collapse: collapse; font-size: 11px; }
    .totals td { padding: 1.5px 0; }
    .totals td.num { text-align: right; white-space: nowrap; }
    .totals tr.grand td { font-size: 15px; font-weight: 700; border-top: 1px solid #111; padding-top: 5px; }
    .totals tr.saving td { color: #0f7b3f; }
    .pay { margin-top: 6px; font-size: 10.5px; }
    .pay .row { display: flex; justify-content: space-between; }
    .code { text-align: center; margin-top: 10px; }
    .code svg { max-width: 100%; height: auto; }
    .code .num { font-size: 10px; letter-spacing: .18em; margin-top: 2px; }
    .foot { text-align: center; font-size: 10px; color: #333; margin-top: 10px; white-space: pre-line; }
    .terms { font-size: 9px; color: #666; margin-top: 6px; text-align: center; white-space: pre-line; }
    .flag { display: inline-block; border: 1px solid #111; padding: 1px 8px; font-size: 10px; letter-spacing: .2em; text-transform: uppercase; margin: 6px auto; }
    .center { text-align: center; }
    @media print {
        body { background: #fff; }
        .sheet { width: auto; margin: 0; box-shadow: none; padding: 0 2mm; }
        @page { size: 80mm auto; margin: 0; }
    }
    """,
    "a4": """
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef1f6; font-family: "Segoe UI", Inter, Arial, sans-serif; color: #0f172a; }
    .sheet { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; padding: 20mm 18mm; box-shadow: 0 20px 50px rgba(15, 23, 42, .14); }
    .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #111; padding-bottom: 14px; }
    .brand h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -.02em; }
    .brand p { margin: 1px 0; font-size: 12px; color: #475569; }
    .brand img { max-height: 64px; max-width: 180px; object-fit: contain; margin-bottom: 6px; }
    .doc { text-align: right; }
    .doc h2 { margin: 0; font-size: 13px; letter-spacing: .28em; text-transform: uppercase; color: #64748b; }
    .doc .no { font-size: 22px; font-weight: 700; margin: 4px 0 8px; }
    .doc table { margin-left: auto; font-size: 12px; border-collapse: collapse; }
    .doc td { padding: 1px 0 1px 14px; text-align: right; }
    .doc td:first-child { color: #64748b; text-align: left; }
    .parties { display: flex; gap: 40px; margin: 22px 0; font-size: 12.5px; }
    .parties h3 { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: #64748b; margin: 0 0 6px; }
    .parties .name { font-weight: 700; font-size: 14px; }
    table.items { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
    table.items thead th { background: #0f172a; color: #fff; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; padding: 9px 10px; text-align: left; }
    table.items td { padding: 9px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    table.items th.num, table.items td.num { text-align: right; }
    .item-note { font-size: 11px; color: #64748b; font-style: italic; }
    .item-sku { font-size: 10.5px; color: #94a3b8; }
    .summary { display: flex; justify-content: flex-end; margin-top: 18px; }
    .totals { width: 78mm; border-collapse: collapse; font-size: 12.5px; }
    .totals td { padding: 4px 0; }
    .totals td.num { text-align: right; }
    .totals tr.grand td { font-size: 17px; font-weight: 700; border-top: 2px solid #0f172a; padding-top: 9px; }
    .totals tr.saving td { color: #047857; }
    .pay { margin-top: 16px; font-size: 12px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
    .pay .row { display: flex; gap: 12px; }
    .code { margin-top: 18px; display: flex; align-items: center; gap: 16px; }
    .code svg { height: 54px; }
    .foot { margin-top: 22px; border-top: 1px solid #e2e8f0; padding-top: 14px; font-size: 11.5px; color: #475569; white-space: pre-line; }
    .flag { display: inline-block; border: 1.5px solid #b91c1c; color: #b91c1c; padding: 2px 10px; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; }
    @media print { body { background: #fff; } .sheet { margin: 0; box-shadow: none; width: auto; padding: 12mm; } @page { size: A4; margin: 0; } }
    """,
    "minimal": """
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7fb; font-family: ui-sans-serif, "Segoe UI", Arial, sans-serif; color: #111; }
    .sheet { width: 80mm; margin: 12px auto; background: #fff; padding: 7mm 6mm; font-size: 12px; box-shadow: 0 10px 30px rgba(15,23,42,.12); }
    .brand { text-align: center; }
    .brand h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: .14em; text-transform: uppercase; }
    .brand p { margin: 0; font-size: 10px; color: #555; }
    .brand img { max-width: 40mm; max-height: 16mm; object-fit: contain; }
    .rule { height: 1px; background: #111; margin: 10px 0; opacity: .18; }
    .meta { font-size: 10.5px; color: #444; }
    .meta .row { display: flex; justify-content: space-between; }
    table.items { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
    table.items td { padding: 4px 0; border-bottom: 1px solid #eee; vertical-align: top; }
    table.items td.num { text-align: right; white-space: nowrap; }
    .item-name { font-weight: 600; }
    .item-note { font-size: 9.5px; color: #666; }
    .totals { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11.5px; }
    .totals td.num { text-align: right; }
    .totals tr.grand td { font-size: 15px; font-weight: 700; padding-top: 6px; }
    .totals tr.saving td { color: #0f7b3f; }
    .pay { margin-top: 8px; font-size: 10.5px; color: #333; }
    .code { text-align: center; margin-top: 12px; }
    .foot { text-align: center; font-size: 10px; color: #555; margin-top: 10px; white-space: pre-line; }
    .terms { font-size: 9px; color: #888; text-align: center; margin-top: 6px; white-space: pre-line; }
    .flag { display: block; text-align: center; font-size: 10px; letter-spacing: .24em; text-transform: uppercase; margin: 8px 0; }
    @media print { body { background: #fff; } .sheet { margin: 0; box-shadow: none; padding: 0 2mm; } @page { size: 80mm auto; margin: 0; } }
    """,
}


def _tax_breakdown(items) -> "OrderedDict[str, int]":
    breakdown: "OrderedDict[str, int]" = OrderedDict()
    for item in items:
        key = f"{(item.tax_rate_percent or 0):g}"
        breakdown[key] = breakdown.get(key, 0) + (item.tax_cents or 0)
    return breakdown


def render_receipt(company, sale, *, auto_print: bool = False) -> str:
    settings = company.settings
    config = company.module_config("receipts")
    template = config.get("template") or "thermal"
    if template not in TEMPLATE_CSS:
        template = "thermal"

    branding = settings.get("branding", {})
    business = settings.get("business", {})
    receipts = settings.get("receipts", {})
    module_enabled = company.module_enabled("receipts")

    show_logo = bool(config.get("show_logo", True)) and module_enabled
    show_barcode = bool(config.get("show_barcode", True)) and module_enabled
    show_qr = bool(config.get("show_qr", False)) and module_enabled
    show_cashier = bool(config.get("show_cashier", True))
    show_tax = company.module_config("tax_engine").get("show_breakdown", True)

    logo_url = branding.get("logo_data_url") or ""
    logotype = company.wordmark
    location_line = ""
    if company.module_enabled("multi_location") and company.module_config("multi_location").get(
        "show_location_on_receipt", True
    ) and sale.location:
        location_line = sale.location.name

    address_lines = [business.get("address"), business.get("city"), business.get("country")]
    address = ", ".join([line for line in address_lines if line])

    meta_rows = [
        ("Receipt", sale.number),
        ("Date", _dt(sale.created_at, company)),
        ("Served by", sale.user.full_name if sale.user else "—"),
        ("Register", sale.register.name if sale.register else "—"),
    ]
    if location_line:
        meta_rows.append(("Location", location_line))
    if sale.customer:
        meta_rows.append(("Customer", sale.customer.name))

    if show_barcode and template in {"thermal", "minimal"}:
        meta_rows = [row for row in meta_rows if row[0] != "Receipt"]
        meta_rows.insert(0, ("Receipt", sale.number))

    item_rows = []
    for item in sale.items:
        note = (
            f'<div class="item-note">{_e(item.note)}</div>' if item.note else ""
        )
        sku = (
            f'<div class="item-sku">{_e(item.sku)}</div>' if template == "a4" and item.sku else ""
        )
        qty = f"{item.qty:g}"
        item_rows.append(
            "<tr>"
            f'<td class="num">{_e(qty)}</td>'
            f'<td><div class="item-name">{_e(item.name)}</div>{sku}{note}</td>'
            f'<td class="num">{_e(money(item.unit_price_cents, settings))}</td>'
            f'<td class="num">{_e(money(item.line_total_cents, settings))}</td>'
            "</tr>"
        )

    totals = [
        ("Subtotal", sale.subtotal_cents, ""),
    ]
    if sale.discount_cents:
        label = sale.discount_label or "Discount"
        totals.append((label, -sale.discount_cents, "saving"))
    if show_tax:
        for rate, amount in _tax_breakdown(sale.items).items():
            totals.append((f"Tax ({rate}%)", amount, ""))
    if sale.service_charge_cents:
        totals.append(("Service charge", sale.service_charge_cents, ""))
    if sale.tip_cents:
        totals.append(("Tip", sale.tip_cents, ""))
    if sale.rounding_cents:
        totals.append(("Rounding", sale.rounding_cents, ""))
    if sale.refunded_cents:
        totals.append(("Refunded", -sale.refunded_cents, "saving"))

    totals_rows = "".join(
        f'<tr class="{cls}"><td>{_e(label)}</td>'
        f'<td class="num">{_e(money(value, settings))}</td></tr>'
        for label, value, cls in totals
    )

    payment_rows = "".join(
        f'<div class="row"><span>{_e(p.method_name)}</span>'
        f'<span>{_e(money(p.amount_cents, settings))}</span></div>'
        for p in sale.payments
    )
    if sale.change_cents:
        payment_rows += (
            f'<div class="row"><span>Change</span><span>{_e(money(sale.change_cents, settings))}</span></div>'
        )

    flags = ""
    if sale.status == "voided":
        flags = '<div class="flag">Voided</div>'
    elif sale.status == "refunded":
        flags = '<div class="flag">Refunded</div>'
    elif sale.status == "partially_refunded":
        flags = '<div class="flag">Partially refunded</div>'

    loyalty = ""
    if sale.loyalty_points_earned or sale.loyalty_points_redeemed:
        loyalty = (
            f'<div class="center" style="font-size:10px;margin-top:6px">'
            f"Points earned: {sale.loyalty_points_earned} &nbsp; Redeemed: {sale.loyalty_points_redeemed}</div>"
        )

    barcode_block = ""
    if show_barcode:
        svg = barcode_svg(sale.number)
        if svg:
            barcode_block = f'<div class="code">{svg}<div class="num">{_e(sale.number)}</div></div>'
    qr_block = ""
    if show_qr:
        svg = qr_svg(f"{sale.number}|{sale.total_cents}")
        if svg:
            qr_block = f'<div class="code">{svg}</div>'

    footer_note = config.get("footer_note") or receipts.get("thank_you") or ""
    terms = receipts.get("terms") or ""
    header_note = receipts.get("header_note") or ""

    business_meta = " · ".join(
        [part for part in [business.get("phone"), business.get("email"), business.get("website")] if part]
    )
    tax_line = f"VAT Reg No: {business.get('tax_number')}" if business.get("tax_number") else ""
    reg_line = f"Company Reg No: {business.get('company_reg_number')}" if business.get("company_reg_number") else ""

    if template == "a4":
        layout = f"""
        <div class="sheet">
          <div class="head">
            <div class="brand">
              {f'<img src="{_e(logo_url)}" alt="logo">' if show_logo and logo_url else ''}
              <h1>{_e(logotype)}</h1>
              {f'<p>{_e(address)}</p>' if address else ''}
              {f'<p>{_e(business_meta)}</p>' if business_meta else ''}
              {f'<p>{_e(tax_line)}</p>' if tax_line else ''}
              {f'<p>{_e(reg_line)}</p>' if reg_line else ''}
            </div>
            <div class="doc">
              <h2>{'Tax Invoice' if business.get('tax_number') else 'Receipt'}</h2>
              <div class="no">{_e(sale.number)}</div>
              <table>
                {''.join(f'<tr><td>{_e(k)}</td><td>{_e(v)}</td></tr>' for k, v in meta_rows)}
              </table>
            </div>
          </div>
          {flags}
          <div class="parties">
            <div>
              <h3>Billed to</h3>
              <div class="name">{_e(sale.customer.name if sale.customer else 'Walk-in customer')}</div>
              {f'<div>{_e(sale.customer.phone)}</div>' if sale.customer and sale.customer.phone else ''}
              {f'<div>{_e(sale.customer.email)}</div>' if sale.customer and sale.customer.email else ''}
              {f'<div>{_e(sale.customer.address)}</div>' if sale.customer and sale.customer.address else ''}
            </div>
            <div>
              <h3>Notes</h3>
              <div>{_e(sale.note or header_note or '—')}</div>
            </div>
          </div>
          <table class="items">
            <thead>
              <tr><th class="num">Qty</th><th>Description</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
            </thead>
            <tbody>{''.join(item_rows)}</tbody>
          </table>
          <div class="summary">
            <table class="totals">
              {totals_rows}
              <tr class="grand"><td>Total</td><td class="num">{_e(money(sale.total_cents, settings))}</td></tr>
            </table>
          </div>
          <div class="pay">
            <strong>Payments</strong>
            {payment_rows}
          </div>
          {loyalty}
          <div class="code">{barcode_block}{qr_block}</div>
          <div class="foot">{_e(footer_note)}
            {f'<div class="terms">{_e(terms)}</div>' if terms else ''}
          </div>
        </div>
        """
    else:
        meta_table = "".join(
            f"<tr><td>{_e(k)}</td><td>{_e(v)}</td></tr>" for k, v in meta_rows
        )
        layout = f"""
        <div class="sheet">
          <div class="brand">
            {f'<img src="{_e(logo_url)}" alt="logo">' if show_logo and logo_url else ''}
            <h1>{_e(logotype)}</h1>
            {f'<p>{_e(address)}</p>' if address else ''}
            {f'<p>{_e(business_meta)}</p>' if business_meta else ''}
            {f'<p>{_e(tax_line)}</p>' if tax_line else ''}
            {f'<p>{_e(reg_line)}</p>' if reg_line else ''}
          </div>
          <div class="rule"></div>
          {flags}
          <div class="meta"><table>{meta_table}</table></div>
          <div class="rule"></div>
          <table class="items">
            <thead><tr><th>Qty</th><th>Item</th><th class="num">Amount</th></tr></thead>
            <tbody>{''.join(item_rows)}</tbody>
          </table>
          <div class="rule"></div>
          <table class="totals">
            {totals_rows}
            <tr class="grand"><td>Total</td><td class="num">{_e(money(sale.total_cents, settings))}</td></tr>
          </table>
          <div class="pay">{payment_rows}</div>
          {loyalty}
          {barcode_block}
          {qr_block}
          <div class="foot">{_e(footer_note)}</div>
          {f'<div class="terms">{_e(terms)}</div>' if terms else ''}
        </div>
        """

    title = f"{logotype} · {sale.number}"
    auto = "<script>window.addEventListener('load',function(){window.print()})</script>" if auto_print else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_e(title)}</title>
<style>{TEMPLATE_CSS[template]}</style>
</head>
<body>
{layout}
{auto}
</body>
</html>"""


def module_label(key: str) -> str:
    module = MODULE_BY_KEY.get(key, {})
    return module.get("name", key)

def render_layby_statement(company, layby, *, payment=None) -> str:
    """A lay-by agreement / statement showing what is paid and what is still due."""
    settings_dict = company.settings
    branding = settings_dict.get("branding", {})
    business = settings_dict.get("business", {})
    receipts = settings_dict.get("receipts", {})
    config = company.module_config("receipts")
    template = config.get("template") if config.get("template") in TEMPLATE_CSS else "thermal"
    if template == "a4":
        template = "thermal"

    logo_url = branding.get("logo_data_url") or ""
    logotype = company.wordmark
    address_lines = [business.get("address"), business.get("city"), business.get("country")]
    address = ", ".join([line for line in address_lines if line])
    meta = " · ".join([part for part in [business.get("phone"), business.get("email")] if part])
    tax_line = f"VAT Reg No: {business.get('tax_number')}" if business.get("tax_number") else ""
    reg_line = f"Company Reg No: {business.get('company_reg_number')}" if business.get("company_reg_number") else ""

    rows = "".join(
        "<tr>"
        f'<td class="num">{_e(f"{item.qty:g}")}</td>'
        f"<td><div class='item-name'>{_e(item.name)}</div></td>"
        f'<td class="num">{_e(money(item.unit_price_cents, settings_dict))}</td>'
        f'<td class="num">{_e(money(item.line_total_cents, settings_dict))}</td>'
        "</tr>"
        for item in layby.items
    )

    payment_rows = "".join(
        "<tr>"
        f'<td>{_e(_dt(entry.created_at, company))}</td>'
        f"<td>{_e(entry.method_name)}</td>"
        f'<td class="num">{_e(money(entry.amount_cents, settings_dict))}</td>'
        "</tr>"
        for entry in layby.payments
    )

    status_label = {"active": "ACTIVE", "completed": "SETTLED", "cancelled": "CANCELLED"}.get(layby.status, layby.status.upper())
    barcode_block = ""
    svg = barcode_svg(layby.number, height=38, module=1.4)
    if svg:
        barcode_block = f'<div class="code">{svg}<div class="num">{_e(layby.number)}</div></div>'

    footer_note = config.get("footer_note") or receipts.get("thank_you") or ""
    terms = receipts.get("terms") or ""

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{_e(logotype)} · Lay-by {_e(layby.number)}</title>
<style>{TEMPLATE_CSS[template]}</style></head>
<body><div class="sheet">
  <div class="brand">
    {f'<img src="{_e(logo_url)}" alt="logo">' if logo_url else ''}
    <h1>{_e(logotype)}</h1>
    {f'<p>{_e(address)}</p>' if address else ''}
    {f'<p>{_e(meta)}</p>' if meta else ''}
    {f'<p>{_e(tax_line)}</p>' if tax_line else ''}
    {f'<p>{_e(reg_line)}</p>' if reg_line else ''}
  </div>
  <div class="rule"></div>
  <div class="center" style="font-size:11px;letter-spacing:.24em;text-transform:uppercase;margin-bottom:6px">Lay-by agreement</div>
  <div class="center"><span class="flag">{_e(status_label)}</span></div>
  <div class="meta"><table>
    <tr><td>Lay-by</td><td>{_e(layby.number)}</td></tr>
    <tr><td>Opened</td><td>{_e(_dt(layby.created_at, company))}</td></tr>
    <tr><td>Customer</td><td>{_e(layby.customer.name if layby.customer else 'Walk-in')}</td></tr>
    {f'<tr><td>Phone</td><td>{_e(layby.customer.phone)}</td></tr>' if layby.customer and layby.customer.phone else ''}
    <tr><td>Due</td><td>{_e(_dt(layby.due_date, company))}</td></tr>
  </table></div>
  <div class="rule"></div>
  <table class="items">
    <thead><tr><th>Qty</th><th>Item</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>{rows}</tbody>
  </table>
  <div class="rule"></div>
  <table class="totals">
    <tr><td>Lay-by total</td><td class="num">{_e(money(layby.total_cents, settings_dict))}</td></tr>
    <tr class="saving"><td>Paid to date</td><td class="num">{_e(money(layby.paid_cents, settings_dict))}</td></tr>
    <tr class="grand"><td>Balance due</td><td class="num">{_e(money(layby.balance_cents, settings_dict))}</td></tr>
  </table>
  <div class="rule"></div>
  <div class="tiny" style="text-transform:uppercase;letter-spacing:.14em;font-weight:700;margin-bottom:4px">Payment history</div>
  <table class="items"><tbody>{payment_rows}</tbody></table>
  {barcode_block}
  <div class="foot">{_e(footer_note)}</div>
  {f'<div class="terms">{_e(terms)}</div>' if terms else ''}
  <div class="terms">Goods remain the property of {_e(logotype)} until this lay-by is paid in full.</div>
</div></body></html>"""
