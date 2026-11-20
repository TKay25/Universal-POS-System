"""Barcode numbering, symbology choice and printable label sheets.

Products store their barcode as plain text. A 13-digit code with a valid EAN-13
check digit prints as EAN-13 (what every retail scanner expects); anything else
(SKU-style codes, receipt numbers) falls back to Code 128, which the receipt
renderer already draws. Labels are generated as a self-contained HTML page so a
browser print dialog can drive a label printer on a roll or a sheet of A4.
"""

from __future__ import annotations

import html
import random
import secrets

from app.services.receipt import barcode_svg, money

# GS1 reserves 20-29 for in-store codes, so our numbering can never collide with
# a manufacturer's real EAN.
EAN_PREFIX = "20"

_EAN_L = ("0001101", "0011001", "0010011", "0111101", "0100011",
          "0110001", "0101111", "0111011", "0110111", "0001011")
_EAN_G = ("0100111", "0110011", "0011011", "0100001", "0011101",
          "0111001", "0000101", "0010001", "0001001", "0010111")
_EAN_R = ("1110010", "1100110", "1101100", "1000010", "1011100",
          "1001110", "1010000", "1000100", "1001000", "1110100")
_EAN_PARITY = ("LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
               "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL")


def ean13_check_digit(body: str) -> str:
    """The 13th digit for a 12-digit body (odd positions weigh 1, even weigh 3)."""
    total = sum(int(digit) * (3 if index % 2 else 1) for index, digit in enumerate(body))
    return str((10 - total % 10) % 10)


def is_ean13(code: str) -> bool:
    code = (code or "").strip()
    return (
        len(code) == 13
        and code.isdigit()
        and ean13_check_digit(code[:12]) == code[12]
    )


def new_code(taken: set[str] | None = None) -> str:
    """A fresh in-store EAN-13 that no other product in the workspace uses."""
    taken = taken or set()
    for _ in range(200):
        body = EAN_PREFIX + "".join(str(secrets.randbelow(10)) for _ in range(10))
        code = body + ean13_check_digit(body)
        if code not in taken:
            return code
    # Practically unreachable; keeps the function total without an infinite loop.
    while True:
        code = EAN_PREFIX + "".join(str(random.randint(0, 9)) for _ in range(11))
        if code not in taken:
            return code


def ean13_svg(data: str, *, height: int = 46, module: float = 1.7, quiet: int = 11) -> str:
    """Draw a valid EAN-13 as inline SVG. Returns "" for anything that is not one."""
    code = (data or "").strip()
    if not is_ean13(code):
        return ""

    pattern = _EAN_PARITY[int(code[0])]
    modules = list("101")  # start guard
    for index, digit in enumerate(code[1:7]):
        table = _EAN_L if pattern[index] == "L" else _EAN_G
        modules.append(table[int(digit)])
    modules.append("01010")  # centre guard
    for digit in code[7:]:
        modules.append(_EAN_R[int(digit)])
    modules.append("101")  # end guard
    bits = "".join(modules)

    rects: list[str] = []
    start = None
    for index, bit in enumerate(bits + "0"):
        if bit == "1" and start is None:
            start = index
        elif bit == "0" and start is not None:
            rects.append(
                f'<rect x="{round((quiet + start) * module, 2)}" y="0" '
                f'width="{round((index - start) * module, 2)}" height="{height}"/>'
            )
            start = None

    width_px = round((len(bits) + quiet * 2) * module, 2)
    return (
        f'<svg class="barcode barcode--ean" xmlns="http://www.w3.org/2000/svg" width="{width_px}" '
        f'height="{height}" viewBox="0 0 {width_px} {height}" role="img" '
        f'aria-label="Barcode {html.escape(code)}"><g fill="#000">{"".join(rects)}</g></svg>'
    )


def barcode_for(code: str, *, height: int = 46, module: float = 1.7) -> str:
    """EAN-13 when the code is one, Code 128 otherwise."""
    return ean13_svg(code, height=height, module=module) or barcode_svg(code, height=height, module=module)


def _label_card(product, *, show_price: bool, settings: dict, svg: str, sheet: bool) -> str:
    price = ""
    if show_price:
        price = f'<span class="price">{html.escape(money(product.price_cents, settings))}</span>'
    name = html.escape(product.name or "")
    sku = html.escape(product.sku or "")
    code = html.escape(product.barcode or product.sku or f"P{product.id}")
    border = "border:1px dashed #c9cfdd;" if sheet else ""
    return (
        f'<div class="label" style="{border}">'
        f'<div class="head"><div class="name">{name}</div>'
        f'{f"<div class=sku>{sku}</div>" if sku else ""}</div>'
        f'<div class="codes">{svg}</div>'
        f'<div class="foot"><span class="code">{code}</span>{price}</div>'
        f"</div>"
    )


def labels_html(
    company,
    products,
    *,
    copies: int = 1,
    layout: str = "sheet",
    width_mm: float | None = None,
    height_mm: float | None = None,
    show_price: bool | None = None,
) -> str:
    """A whole print job: one label per page (roll) or a grid on A4 (sheet)."""
    config = company.module_config("barcode")
    width = float(width_mm or config.get("label_width_mm") or 50)
    height = float(height_mm or config.get("label_height_mm") or 25)
    price_flag = bool(config.get("show_price_on_label", True)) if show_price is None else bool(show_price)
    sheet = layout != "roll"
    settings = company.settings

    cards: list[str] = []
    for product in products:
        svg = barcode_for(product.barcode or product.sku or f"P{product.id}", height=30, module=1.15)
        card = _label_card(product, show_price=price_flag, settings=settings, svg=svg, sheet=sheet)
        cards.extend([card] * max(1, min(int(copies or 1), 200)))

    # A4 sheet geometry: 8 mm margins, 2 mm gutters, as many columns as fit.
    margin, gap = 8.0, 2.0
    columns = max(1, int((210 - margin * 2 + gap) // (width + gap)))
    rows = max(1, int((297 - margin * 2 + gap) // (height + gap)))
    per_sheet = columns * rows

    pages: list[str] = []
    if sheet:
        for index in range(0, len(cards), per_sheet):
            chunk = cards[index:index + per_sheet]
            pages.append(f'<section class="sheet">{"".join(chunk)}</section>')
    else:
        pages = [f'<section class="roll">{card}</section>' for card in cards]

    page_css = (
        f"@page {{ size: A4; margin: {margin}mm; }}"
        if sheet
        else f"@page {{ size: {width}mm {height}mm; margin: 0; }}"
    )
    sheet_css = (
        f".sheet {{ display: grid; grid-template-columns: repeat({columns}, {width}mm); "
        f"gap: {gap}mm; page-break-after: always; }}"
        f".sheet:last-child {{ page-break-after: auto; }}"
        if sheet
        else ".roll { page-break-after: always; } .roll:last-child { page-break-after: auto; }"
    )
    title = html.escape(f"{company.name} labels")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>
  {page_css}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #fff; }}
  .sheet {{ align-content: start; }}
  .label {{
    width: {width}mm; height: {height}mm; padding: 1.6mm 2mm;
    display: flex; flex-direction: column; justify-content: space-between;
    overflow: hidden; break-inside: avoid;
  }}
  .name {{ font-size: 9.4px; font-weight: 700; line-height: 1.15; max-height: 2.3em; overflow: hidden; }}
  .sku {{ font-size: 6.4px; color: #505a6e; letter-spacing: .04em; }}
  .codes {{ text-align: center; }}
  .codes svg {{ max-width: 100%; height: auto; }}
  .foot {{ display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; }}
  .code {{ font-size: 6.6px; color: #505a6e; letter-spacing: .05em; }}
  .price {{ font-size: 10px; font-weight: 800; }}
  @media screen {{ body {{ padding: 10mm; background: #eef1f7; }} .label {{ background: #fff; }} }}
</style></head>
<body>{"".join(pages)}</body></html>"""
