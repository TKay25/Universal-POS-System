"""Checkout, refunds, stock movement and cash-drawer shift logic."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import func, select

from app.extensions import db
from app.models import (
    Customer,
    Discount,
    PaymentMethod,
    Product,
    Refund,
    RefundItem,
    Sale,
    SaleItem,
    SalePayment,
    Shift,
    StockMovement,
)
from app.security import bad_request
from app.services.pricing import price_cart
from app.utils import to_cents, utcnow


def _round(value) -> int:
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def next_sale_number(company) -> str:
    settings = company.settings
    sales = settings.get("sales", {})
    prefix = sales.get("prefix", "INV-") or ""
    number = int(sales.get("next_number", 1) or 1)
    padding = int(sales.get("number_padding", 5) or 0)
    company.update_settings({"sales": {"next_number": number + 1}})
    return f"{prefix}{number:0{padding}d}"


# --------------------------------------------------------------------------- #
# Sales
# --------------------------------------------------------------------------- #
def complete_sale(company, user, payload: dict) -> Sale:
    raw_lines = payload.get("lines") or []
    if not isinstance(raw_lines, list) or not raw_lines:
        raise bad_request("Add at least one item before taking payment.", {"lines": "Cart is empty."})

    pos_cfg = company.module_config("pos")
    inventory_cfg = company.module_config("inventory")
    allow_negative = bool(inventory_cfg.get("allow_negative", False))

    customer = None
    customer_id = payload.get("customer_id")
    if customer_id:
        customer = Customer.query.filter_by(id=customer_id, company_id=company.id).first()
        if customer is None:
            raise bad_request("That customer no longer exists.", {"customer_id": "Unknown customer."})
    elif pos_cfg.get("customer_required"):
        raise bad_request("Select a customer to continue.", {"customer_id": "Customer is required."})

    lines: list[dict] = []
    for index, raw in enumerate(raw_lines):
        product = Product.query.filter_by(id=raw.get("product_id"), company_id=company.id).first()
        if product is None:
            raise bad_request(
                f"Item {index + 1} is no longer in your catalog.",
                {"lines": f"Product {raw.get('product_id')} not found."},
            )
        try:
            qty = float(raw.get("qty", 1) or 0)
        except (TypeError, ValueError):
            raise bad_request("Quantities must be numbers.", {"lines": "Invalid quantity."})
        if qty <= 0:
            raise bad_request("Quantities must be greater than zero.", {"lines": "Invalid quantity."})
        if product.track_stock and not allow_negative and qty > (product.stock_qty or 0):
            raise bad_request(
                f"Only {product.stock_qty:g} × {product.name} left in stock.",
                {"lines": f"Insufficient stock for {product.name}."},
            )
        lines.append(
            {
                "product": product,
                "qty": qty,
                "unit_price_cents": raw.get("unit_price_cents"),
                "discount_cents": raw.get("discount_cents", 0),
                "note": raw.get("note", ""),
            }
        )

    # ---- promotions ------------------------------------------------------ #
    cart_discount = payload.get("discount") or None
    applied_discount = None
    if cart_discount and cart_discount.get("code"):
        code = str(cart_discount["code"]).strip().upper()
        applied_discount = Discount.query.filter_by(company_id=company.id, code=code).first()
        if applied_discount is None or not applied_discount.is_valid_now():
            raise bad_request("That promotion code is not valid.", {"discount": "Invalid or expired code."})
        cart_discount = {
            "type": applied_discount.type,
            "value": applied_discount.value,
            "label": applied_discount.name,
        }
    elif cart_discount and applied_discount is None:
        if company.module_enabled("discounts"):
            manual_cfg = company.module_config("discounts")
            if not manual_cfg.get("allow_manual", True):
                raise bad_request("Manual discounts are disabled for this company.", {"discount": "Not allowed."})
            if (cart_discount.get("type") == "percent"):
                limit = float(manual_cfg.get("max_manual_percent", 100) or 100)
                if float(cart_discount.get("value", 0)) > limit:
                    raise bad_request(
                        f"Manual discounts are capped at {limit:g}%.",
                        {"discount": f"Maximum {limit:g}%."},
                    )
        else:
            raise bad_request("The discounts module is not enabled.", {"discount": "Module disabled."})

    redeemed = int(payload.get("redeem_points") or 0)
    priced = price_cart(
        company,
        lines,
        cart_discount=cart_discount,
        tip_cents=int(payload.get("tip_cents") or 0),
        redeem_points=redeemed,
        customer=customer,
    )
    if priced["total_cents"] <= 0 and not company.settings.get("sales", {}).get("allow_zero_price"):
        raise bad_request("The total must be greater than zero.", {"lines": "Zero-value sale."})

    # ---- payments -------------------------------------------------------- #
    raw_payments = payload.get("payments") or []
    if not isinstance(raw_payments, list) or not raw_payments:
        raise bad_request("Add a payment method.", {"payments": "At least one payment is required."})

    paid_total = 0
    payments: list[SalePayment] = []
    credit_used = 0
    for raw in raw_payments:
        method = PaymentMethod.query.filter_by(id=raw.get("method_id"), company_id=company.id, is_active=True).first()
        if method is None:
            raise bad_request("Choose a valid payment method.", {"payments": "Unknown payment method."})
        amount = int(raw.get("amount_cents") or 0)
        if amount <= 0:
            continue
        tendered = int(raw.get("tendered_cents") or amount)
        if method.requires_reference and not (raw.get("reference") or "").strip():
            raise bad_request(f"{method.name} needs a reference.", {"payments": f"Reference required for {method.name}."})
        if method.type == "credit":
            if customer is None:
                raise bad_request("Store credit needs a customer.", {"payments": "Select a customer."})
            if amount > (customer.credit_balance_cents or 0) + credit_used:
                raise bad_request("Not enough store credit available.", {"payments": "Insufficient store credit."})
            credit_used += amount
        payments.append(
            SalePayment(
                method_id=method.id,
                method_name=method.name,
                method_type=method.type,
                amount_cents=amount,
                tendered_cents=max(tendered, amount),
                change_cents=max(0, tendered - amount),
                reference=(raw.get("reference") or "").strip()[:120],
            )
        )
        paid_total += amount

    if paid_total < priced["total_cents"]:
        shortfall = priced["total_cents"] - paid_total
        raise bad_request(
            f"Payment is short by {shortfall / 100:,.2f}.",
            {"payments": "Collected amount is less than the total."},
        )

    change = paid_total - priced["total_cents"]

    # ---- persist --------------------------------------------------------- #
    sale = Sale(
        company_id=company.id,
        location_id=payload.get("location_id") or None,
        register_id=payload.get("register_id") or None,
        shift_id=payload.get("shift_id") or None,
        user_id=user.id,
        customer_id=customer.id if customer else None,
        discount_id=applied_discount.id if applied_discount else None,
        number=next_sale_number(company),
        status="completed",
        subtotal_cents=priced["subtotal_cents"],
        discount_cents=priced["discount_cents"],
        tax_cents=priced["tax_cents"],
        service_charge_cents=priced["service_charge_cents"],
        tip_cents=priced["tip_cents"],
        rounding_cents=priced["rounding_cents"],
        total_cents=priced["total_cents"],
        paid_cents=paid_total,
        change_cents=change,
        cost_cents=priced["cost_cents"],
        note=(payload.get("note") or "")[:2000],
        discount_label=priced["discount_label"],
        loyalty_points_earned=priced["loyalty_points_earned"],
        loyalty_points_redeemed=priced["loyalty_points_redeemed"],
        source=payload.get("source", "pos"),
        custom_fields=payload.get("custom_fields") or {},
    )
    db.session.add(sale)

    for line in priced["lines"]:
        product: Product = line["product"]
        sale.items.append(
            SaleItem(
                product_id=product.id,
                name=product.name,
                sku=product.sku,
                qty=float(line["qty"]),
                unit_price_cents=line["unit_price_cents"],
                discount_cents=line["discount_cents"],
                tax_rate_percent=line["tax_rate_percent"],
                tax_cents=line["tax_cents"],
                line_subtotal_cents=line["line_subtotal_cents"],
                line_total_cents=line["line_total_cents"],
                cost_cents=line["cost_cents"],
                note=line["note"],
            )
        )
        if product.track_stock:
            product.stock_qty = round((product.stock_qty or 0) - float(line["qty"]), 3)
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=user.id,
                    qty_delta=-float(line["qty"]),
                    balance_after=product.stock_qty,
                    reason="sale",
                    reference=sale.number,
                )
            )

    for payment in payments:
        sale.payments.append(payment)

    if customer is not None:
        customer.total_spent_cents = (customer.total_spent_cents or 0) + priced["total_cents"]
        customer.visits = (customer.visits or 0) + 1
        customer.last_visit_at = utcnow()
        if company.module_enabled("loyalty"):
            customer.loyalty_points = max(
                0,
                (customer.loyalty_points or 0)
                - priced["loyalty_points_redeemed"]
                + priced["loyalty_points_earned"],
            )
        if credit_used:
            customer.credit_balance_cents = max(0, (customer.credit_balance_cents or 0) - credit_used)

    if applied_discount is not None:
        applied_discount.uses = (applied_discount.uses or 0) + 1

    if sale.shift_id:
        shift = db.session.get(Shift, sale.shift_id)
        if shift is not None:
            shift.sales_cents = (shift.sales_cents or 0) + sale.total_cents

    db.session.commit()
    return sale


def void_sale(company, user, sale: Sale, reason: str = "") -> Sale:
    if sale.status == "voided":
        raise bad_request("That sale is already voided.")
    for item in sale.items:
        if item.product_id and item.product:
            product = item.product
            if product.track_stock:
                restock = float(item.qty) - float(item.refunded_qty or 0)
                if restock > 0:
                    product.stock_qty = round((product.stock_qty or 0) + restock, 3)
                    db.session.add(
                        StockMovement(
                            company_id=company.id,
                            product_id=product.id,
                            user_id=user.id,
                            qty_delta=restock,
                            balance_after=product.stock_qty,
                            reason="void",
                            reference=sale.number,
                            note=reason[:240],
                        )
                    )
    if sale.customer is not None:
        sale.customer.total_spent_cents = max(
            0, (sale.customer.total_spent_cents or 0) - sale.total_cents
        )
        if sale.loyalty_points_earned:
            sale.customer.loyalty_points = max(
                0, (sale.customer.loyalty_points or 0) - sale.loyalty_points_earned
            )
    sale.status = "voided"
    if reason:
        sale.note = (sale.note + f"\nVoid reason: {reason}").strip()
    db.session.commit()
    return sale


def refund_sale(company, user, sale: Sale, payload: dict) -> Refund:
    if sale.status == "voided":
        raise bad_request("Voided sales cannot be refunded.")
    cfg = company.module_config("refunds")
    reason = (payload.get("reason") or "").strip()
    if cfg.get("require_reason", True) and not reason:
        raise bad_request("Tell us why this is being refunded.", {"reason": "A reason is required."})

    window = int(cfg.get("refund_window_days", 0) or 0)
    if window and sale.created_at:
        from datetime import timedelta

        if utcnow() - sale.created_at > timedelta(days=window):
            raise bad_request(f"Refunds are only allowed within {window} days of the sale.")

    requested = payload.get("items")
    refund_items: list[RefundItem] = []
    if requested:
        for raw in requested:
            sale_item = next((i for i in sale.items if i.id == raw.get("sale_item_id")), None)
            if sale_item is None:
                raise bad_request("One of the selected items is not on this sale.", {"items": "Unknown item."})
            qty = float(raw.get("qty") or 0)
            if qty <= 0:
                continue
            available = float(sale_item.qty) - float(sale_item.refunded_qty or 0)
            if qty > available + 1e-9:
                raise bad_request(
                    f"Only {available:g} × {sale_item.name} can still be refunded.",
                    {"items": f"Too many {sale_item.name}."},
                )
            per_unit = Decimal(str(sale_item.line_total_cents)) / Decimal(str(sale_item.qty or 1))
            amount = _round(per_unit * Decimal(str(qty)))
            refund_items.append(RefundItem(sale_item_id=sale_item.id, qty=qty, amount_cents=amount))
    else:
        for sale_item in sale.items:
            available = float(sale_item.qty) - float(sale_item.refunded_qty or 0)
            if available <= 0:
                continue
            per_unit = Decimal(str(sale_item.line_total_cents)) / Decimal(str(sale_item.qty or 1))
            amount = _round(per_unit * Decimal(str(available)))
            refund_items.append(RefundItem(sale_item_id=sale_item.id, qty=available, amount_cents=amount))

    if not refund_items:
        raise bad_request("Everything on this sale has already been refunded.")

    amount_cents = sum(item.amount_cents for item in refund_items)
    fully_refunded = all(
        float(i.refunded_qty or 0) + next(
            (float(r.qty) for r in refund_items if r.sale_item_id == i.id), 0.0
        ) >= float(i.qty) - 1e-9
        for i in sale.items
    )
    if fully_refunded:
        # A full return also returns untaxed extras (service charge, tip, rounding).
        remainder = max(0, (sale.total_cents or 0) - (sale.refunded_cents or 0) - amount_cents)
        if remainder:
            refund_items[0].amount_cents += remainder
            amount_cents += remainder

    method = payload.get("method", "original")
    restock = bool(payload.get("restock", cfg.get("restock_by_default", True)))

    refund = Refund(
        company_id=company.id,
        sale_id=sale.id,
        user_id=user.id,
        amount_cents=amount_cents,
        method=method,
        reason=reason[:240],
        restock=restock,
    )
    for item in refund_items:
        refund.items.append(item)
        sale_item = next(i for i in sale.items if i.id == item.sale_item_id)
        sale_item.refunded_qty = float(sale_item.refunded_qty or 0) + float(item.qty)
        if restock and sale_item.product and sale_item.product.track_stock:
            product = sale_item.product
            product.stock_qty = round((product.stock_qty or 0) + float(item.qty), 3)
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=user.id,
                    qty_delta=float(item.qty),
                    balance_after=product.stock_qty,
                    reason="refund",
                    reference=sale.number,
                )
            )

    db.session.add(refund)
    sale.refunded_cents = (sale.refunded_cents or 0) + amount_cents
    sale.status = "refunded" if fully_refunded else "partially_refunded"

    if method == "store_credit" and sale.customer is not None:
        sale.customer.credit_balance_cents = (sale.customer.credit_balance_cents or 0) + amount_cents

    if sale.shift_id:
        shift = db.session.get(Shift, sale.shift_id)
        if shift is not None:
            shift.refunds_cents = (shift.refunds_cents or 0) + amount_cents

    db.session.commit()
    return refund


# --------------------------------------------------------------------------- #
# Shifts
# --------------------------------------------------------------------------- #
def open_shift(company, user, *, register_id=None, opening_float_cents=0, notes="") -> Shift:
    existing = Shift.query.filter_by(company_id=company.id, user_id=user.id, status="open").first()
    if existing is not None:
        raise bad_request("You already have an open shift. Close it before opening a new one.")
    shift = Shift(
        company_id=company.id,
        user_id=user.id,
        register_id=register_id or None,
        status="open",
        opening_float_cents=int(opening_float_cents or 0),
        notes=notes[:2000],
    )
    db.session.add(shift)
    db.session.commit()
    return shift


def shift_cash_summary(company, shift: Shift) -> dict:
    cash_ids = [
        m.id
        for m in PaymentMethod.query.filter_by(company_id=company.id, type="cash").all()
    ]
    cash_in = 0
    if cash_ids:
        cash_in = (
            db.session.execute(
                select(func.coalesce(func.sum(SalePayment.amount_cents - SalePayment.change_cents), 0))
                .join(Sale, Sale.id == SalePayment.sale_id)
                .where(
                    Sale.company_id == company.id,
                    Sale.shift_id == shift.id,
                    Sale.status.in_(["completed", "partially_refunded", "refunded"]),
                    SalePayment.method_id.in_(cash_ids),
                )
            ).scalar_one()
            or 0
        )
    cash_refunds = (
        db.session.execute(
            select(func.coalesce(func.sum(Refund.amount_cents), 0)).where(
                Refund.company_id == company.id,
                Refund.sale_id.in_(select(Sale.id).where(Sale.shift_id == shift.id)),
                Refund.method == "cash",
            )
        ).scalar_one()
        or 0
    )
    expected = (shift.opening_float_cents or 0) + int(cash_in) - int(cash_refunds)
    return {
        "cash_sales_cents": int(cash_in),
        "cash_refunds_cents": int(cash_refunds),
        "expected_cash_cents": expected,
    }


def close_shift(company, shift: Shift, *, counted_cash_cents: int | None, notes="") -> Shift:
    if shift.status == "closed":
        raise bad_request("That shift is already closed.")
    summary = shift_cash_summary(company, shift)
    shift.expected_cash_cents = summary["expected_cash_cents"]
    if counted_cash_cents is not None:
        shift.counted_cash_cents = int(counted_cash_cents)
        shift.variance_cents = int(counted_cash_cents) - summary["expected_cash_cents"]
    shift.status = "closed"
    shift.closed_at = utcnow()
    if notes:
        shift.notes = (shift.notes + f"\n{notes}").strip() if shift.notes else notes
    db.session.commit()
    return shift


def current_shift(company, user) -> Shift | None:
    return (
        Shift.query.filter_by(company_id=company.id, user_id=user.id, status="open")
        .order_by(Shift.opened_at.desc())
        .first()
    )
