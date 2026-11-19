"""Cart pricing engine.

A single place that turns a cart payload into authoritative totals so the POS,
the API and the reports can never disagree about money.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from app.utils import to_cents


def _round(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _dec(value) -> Decimal:
    return Decimal(str(value or 0))


def price_cart(
    company,
    lines: list[dict],
    *,
    cart_discount: dict | None = None,
    tip_cents: int = 0,
    redeem_points: int = 0,
    customer=None,
) -> dict:
    """Price a cart.

    ``lines`` entries carry ``product``, ``qty``, optional ``unit_price_cents``
    override, optional ``discount_cents`` line discount and ``note``.
    """
    settings = company.settings
    tax_cfg = company.module_config("tax_engine")
    tax_enabled = company.module_enabled("tax_engine")
    prices_include_tax = bool(tax_cfg.get("prices_include_tax", False))

    prepared: list[dict] = []
    for raw in lines:
        product = raw["product"]
        qty = _dec(raw.get("qty", 1))
        if qty <= 0:
            continue
        override = raw.get("unit_price_cents")
        unit_price = int(override) if override not in (None, "") else int(product.price_cents or 0)
        line_subtotal = _round(_dec(unit_price) * qty)
        line_discount = max(0, int(raw.get("discount_cents", 0) or 0))
        line_discount = min(line_discount, line_subtotal)

        rate = 0.0
        inclusive = prices_include_tax
        if not tax_enabled:
            rate = 0.0
        elif product.tax_rate is not None:
            rate = float(product.tax_rate.rate or 0)
            inclusive = bool(product.tax_rate.is_inclusive)
        elif settings.get("sales", {}).get("default_tax_rate_id"):
            from app.extensions import db
            from app.models import TaxRate

            fallback = db.session.get(TaxRate, settings["sales"]["default_tax_rate_id"])
            if fallback is not None:
                rate = float(fallback.rate or 0)
                inclusive = bool(fallback.is_inclusive)

        prepared.append(
            {
                "product": product,
                "qty": qty,
                "unit_price_cents": unit_price,
                "line_subtotal_cents": line_subtotal,
                "line_discount_cents": line_discount,
                "base_cents": line_subtotal - line_discount,
                "tax_rate_percent": rate,
                "tax_inclusive": inclusive,
                "note": (raw.get("note") or "")[:240],
                "cost_cents": int(product.cost_cents or 0),
            }
        )

    gross_subtotal = sum(line["line_subtotal_cents"] for line in prepared)
    line_discount_total = sum(line["line_discount_cents"] for line in prepared)
    net_before_cart = gross_subtotal - line_discount_total

    # ---- cart level discount -------------------------------------------- #
    cart_discount_cents = 0
    discount_label = ""
    if cart_discount and net_before_cart > 0:
        kind = cart_discount.get("type", "fixed")
        discount_label = (cart_discount.get("label") or "").strip()
        if kind == "percent":
            percent = min(100.0, max(0.0, float(cart_discount.get("value", 0))))
            cart_discount_cents = _round(_dec(net_before_cart) * _dec(percent) / _dec(100))
        else:
            cart_discount_cents = to_cents(cart_discount.get("value")) if isinstance(
                cart_discount.get("value"), str
            ) else int(cart_discount.get("value", 0) or 0)
        cart_discount_cents = max(0, min(cart_discount_cents, net_before_cart))

    # Allocate the cart discount pro-rata so tax is calculated correctly.
    remaining = cart_discount_cents
    for index, line in enumerate(prepared):
        if cart_discount_cents <= 0 or net_before_cart <= 0:
            allocated = 0
        elif index == len(prepared) - 1:
            allocated = remaining
        else:
            share = _dec(cart_discount_cents) * _dec(line["base_cents"]) / _dec(net_before_cart)
            allocated = min(remaining, _round(share))
        remaining -= allocated
        line["cart_discount_cents"] = allocated
        line["discount_cents"] = line["line_discount_cents"] + allocated
        line["taxable_base_cents"] = line["base_cents"] - allocated

    # ---- tax ------------------------------------------------------------- #
    tax_total = 0
    tax_breakdown: dict[str, int] = {}
    for line in prepared:
        base = line["taxable_base_cents"]
        rate = _dec(line["tax_rate_percent"]) / _dec(100)
        if line["tax_inclusive"]:
            tax = _round(_dec(base) - _dec(base) / (_dec(1) + rate)) if rate else 0
            line_total = base
        else:
            tax = _round(_dec(base) * rate)
            line_total = base + tax
        line["tax_cents"] = tax
        line["line_total_cents"] = line_total
        tax_total += tax
        key = f"{line['tax_rate_percent']:g}"
        tax_breakdown[key] = tax_breakdown.get(key, 0) + tax

    net_cents = sum(line["taxable_base_cents"] for line in prepared)
    gross_after_discount = gross_subtotal - line_discount_total - cart_discount_cents

    # ---- service charge, tip, rounding, loyalty ------------------------- #
    service_cfg = company.module_config("service_charge")
    service_charge_cents = 0
    if company.module_enabled("service_charge"):
        percent = float(service_cfg.get("percent", 0) or 0)
        service_charge_cents = _round(_dec(net_cents) * _dec(percent) / _dec(100))

    tip_cents = max(0, int(tip_cents or 0))

    redeem_cents = 0
    loyalty_cfg = company.module_config("loyalty")
    points_redeemed = 0
    if company.module_enabled("loyalty") and customer is not None and redeem_points:
        requested = min(int(redeem_points), int(customer.loyalty_points or 0))
        minimum = int(loyalty_cfg.get("minimum_redeem", 0) or 0)
        if requested < minimum:
            requested = 0
        unit_value = int(loyalty_cfg.get("redeem_value", 1) or 0)
        redeem_cents = requested * unit_value
        subtotal_for_cap = net_cents + tax_total + service_charge_cents + tip_cents
        if redeem_cents > subtotal_for_cap:
            redeem_cents = subtotal_for_cap
            points_redeemed = requested if unit_value == 0 else subtotal_for_cap // max(1, unit_value)
        else:
            points_redeemed = requested

    total_before_rounding = net_cents + tax_total + service_charge_cents + tip_cents - redeem_cents

    rounding_cents = 0
    if company.module_enabled("rounding") and total_before_rounding > 0:
        cfg = company.module_config("rounding")
        increment = max(1, int(cfg.get("increment", 5) or 1))
        mode = cfg.get("mode", "nearest")
        quotient, remainder = divmod(total_before_rounding, increment)
        if remainder == 0:
            target = total_before_rounding
        elif mode == "up":
            target = (quotient + 1) * increment
        elif mode == "down":
            target = quotient * increment
        else:
            target = (quotient + 1) * increment if remainder * 2 >= increment else quotient * increment
        rounding_cents = target - total_before_rounding

    total_cents = total_before_rounding + rounding_cents
    cost_total = sum(_round(_dec(line["cost_cents"]) * line["qty"]) for line in prepared)

    points_earned = 0
    if company.module_enabled("loyalty") and customer is not None:
        per_100 = float(loyalty_cfg.get("points_per_100", 0) or 0)
        points_earned = int((total_cents / 100) * per_100)

    return {
        "lines": prepared,
        "gross_subtotal_cents": gross_subtotal,
        "subtotal_cents": gross_after_discount,
        "discount_cents": line_discount_total + cart_discount_cents,
        "discount_label": discount_label,
        "net_cents": net_cents,
        "tax_cents": tax_total,
        "tax_breakdown": tax_breakdown,
        "service_charge_cents": service_charge_cents,
        "tip_cents": tip_cents,
        "rounding_cents": rounding_cents,
        "redeem_cents": redeem_cents,
        "loyalty_points_redeemed": points_redeemed,
        "loyalty_points_earned": points_earned,
        "total_cents": total_cents,
        "cost_cents": cost_total,
        "item_count": float(sum(line["qty"] for line in prepared)),
    }
