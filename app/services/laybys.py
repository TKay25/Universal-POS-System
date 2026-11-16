"""Lay-by / layaway: deposit, reserve stock, pay over time, complete or cancel."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from app.extensions import db
from app.models import (
    Customer,
    Layby,
    LaybyItem,
    LaybyPayment,
    PaymentMethod,
    Product,
    Sale,
    SaleItem,
    SalePayment,
    StockMovement,
)
from app.security import ApiError, bad_request
from app.services.checkout import next_sale_number
from app.services.pricing import price_cart
from app.services.timezones import local_today, zone_for
from app.utils import iso, to_cents, utcnow


def _config(company) -> dict:
    return company.module_config("layby")


def next_layby_number(company) -> str:
    counter = int((company.settings.get("layby") or {}).get("next_number", 1) or 1)
    company.update_settings({"layby": {"next_number": counter + 1}})
    return f"LAY-{counter:05d}"


def require_module(company) -> None:
    if not company.module_enabled("layby"):
        raise bad_request("Enable the Lay-by module in settings before using lay-by.")


def _parse_local_date(value) -> datetime | None:
    if not value:
        return None
    try:
        day = datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        raise bad_request("The due date is not a valid date.", {"due_date": "Invalid date."})
    return day


def create_layby(company, user, payload: dict) -> Layby:
    require_module(company)
    cfg = _config(company)

    customer = None
    if payload.get("customer_id"):
        customer = Customer.query.filter_by(id=payload["customer_id"], company_id=company.id).first()
        if customer is None:
            raise bad_request("That customer no longer exists.", {"customer_id": "Unknown customer."})
    if customer is None and cfg.get("require_customer", True):
        raise bad_request("A registered customer is required for lay-by.", {"customer_id": "Customer is required."})

    raw_lines = payload.get("lines") or []
    if not isinstance(raw_lines, list) or not raw_lines:
        raise bad_request("Add at least one item to the lay-by.", {"lines": "No items."})

    lines = []
    for raw in raw_lines:
        product = Product.query.filter_by(id=raw.get("product_id"), company_id=company.id).first()
        if product is None:
            raise bad_request("One of the items is no longer available.", {"lines": "Unknown product."})
        try:
            qty = float(raw.get("qty") or 0)
        except (TypeError, ValueError):
            raise bad_request("Quantities must be numbers.", {"lines": "Invalid quantity."})
        if qty <= 0:
            raise bad_request("Quantities must be greater than zero.", {"lines": "Invalid quantity."})
        allow_negative = bool(company.module_config("inventory").get("allow_negative"))
        if product.track_stock and not allow_negative and qty > (product.stock_qty or 0):
            raise bad_request(
                f"Only {product.stock_qty:g} × {product.name} available to reserve.",
                {"lines": f"Insufficient stock for {product.name}."},
            )
        lines.append(
            {
                "product": product,
                "qty": qty,
                "unit_price_cents": raw.get("unit_price_cents"),
            }
        )

    priced = price_cart(company, lines, customer=customer)
    total = priced["total_cents"]
    if total <= 0:
        raise bad_request("A lay-by must have a value greater than zero.")

    if payload.get("deposit_amount") in (None, ""):
        raise bad_request("Enter the deposit the customer is paying today.", {"deposit_amount": "Deposit is required."})
    deposit_cents = to_cents(payload.get("deposit_amount"))
    minimum = max(int(cfg.get("min_deposit", 0) or 0), int(round(total * float(cfg.get("deposit_percent", 0) or 0) / 100)))
    if deposit_cents < minimum:
        raise bad_request(
            f"The deposit must be at least {minimum / 100:,.2f}.",
            {"deposit_amount": "Deposit is below the minimum."},
        )
    if deposit_cents >= total:
        raise bad_request(
            "That deposit covers the full amount — take it as a normal sale instead.",
            {"deposit_amount": "Deposit equals the total."},
        )

    max_days = int(cfg.get("max_days", 90) or 90)
    today = local_today(company)
    due_day = _parse_local_date(payload.get("due_date")) or (today + timedelta(days=max_days))
    if due_day <= today:
        raise bad_request("The due date must be in the future.", {"due_date": "Choose a later date."})
    if (due_day - today).days > max_days:
        raise bad_request(f"Lay-bys can run for at most {max_days} days.", {"due_date": "Too far away."})
    due_local = datetime.combine(due_day, time(23, 59), tzinfo=zone_for(company))
    due_utc = due_local.astimezone(timezone.utc).replace(tzinfo=None)

    method = None
    if payload.get("payment_method_id"):
        method = PaymentMethod.query.filter_by(
            id=payload["payment_method_id"], company_id=company.id, is_active=True
        ).first()
        if method is None:
            raise bad_request("Choose a valid payment method.", {"payment_method_id": "Unknown method."})

    layby = Layby(
        company_id=company.id,
        customer_id=customer.id if customer else None,
        user_id=user.id,
        number=next_layby_number(company),
        status="active",
        total_cents=total,
        deposit_cents=deposit_cents,
        paid_cents=deposit_cents,
        due_date=due_utc,
        note=(payload.get("note") or "")[:2000],
    )
    db.session.add(layby)

    for line in priced["lines"]:
        product = line["product"]
        layby.items.append(
            LaybyItem(
                product_id=product.id,
                name=product.name,
                sku=product.sku,
                qty=float(line["qty"]),
                unit_price_cents=line["unit_price_cents"],
                line_total_cents=line["line_total_cents"],
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
                    reason="layby",
                    reference=layby.number,
                )
            )

    layby.payments.append(
        LaybyPayment(
            method_id=method.id if method else None,
            method_name=method.name if method else "Cash",
            method_type=method.type if method else "cash",
            amount_cents=deposit_cents,
            reference=(payload.get("reference") or "").strip()[:120],
            user_id=user.id,
            created_at=utcnow(),
        )
    )
    db.session.commit()
    return layby


def add_payment(company, user, layby: Layby, payload: dict) -> Layby:
    require_module(company)
    if layby.status != "active":
        raise bad_request("Only active lay-bys can take payments.")

    amount = to_cents(payload.get("amount")) if payload.get("amount") is not None else int(payload.get("amount_cents") or 0)
    if amount <= 0:
        raise bad_request("Enter a payment amount.", {"amount": "Amount is required."})
    if amount > layby.balance_cents:
        raise bad_request(
            f"Only {layby.balance_cents / 100:,.2f} is still outstanding.",
            {"amount": "Payment exceeds the balance."},
        )

    method = None
    if payload.get("payment_method_id"):
        method = PaymentMethod.query.filter_by(
            id=payload["payment_method_id"], company_id=company.id, is_active=True
        ).first()
        if method is None:
            raise bad_request("Choose a valid payment method.", {"payment_method_id": "Unknown method."})
    if method is not None and method.requires_reference and not (payload.get("reference") or "").strip():
        raise bad_request(f"{method.name} needs a reference.", {"reference": "Reference required."})

    layby.payments.append(
        LaybyPayment(
            method_id=method.id if method else None,
            method_name=method.name if method else "Cash",
            method_type=method.type if method else "cash",
            amount_cents=amount,
            reference=(payload.get("reference") or "").strip()[:120],
            user_id=user.id,
            created_at=utcnow(),
        )
    )
    layby.paid_cents = (layby.paid_cents or 0) + amount
    db.session.commit()

    if layby.balance_cents <= 0:
        complete_layby(company, user, layby)
    return layby


def complete_layby(company, user, layby: Layby) -> Sale:
    if layby.status == "completed":
        raise bad_request("That lay-by is already completed.")
    if layby.status != "active":
        raise bad_request("Cancelled lay-bys cannot be completed.")
    if layby.balance_cents > 0:
        raise bad_request(
            f"{layby.balance_cents / 100:,.2f} is still outstanding.",
            {"amount": "Balance outstanding."},
        )

    lines = [{"product": item.product, "qty": item.qty, "unit_price_cents": item.unit_price_cents}
             for item in layby.items if item.product is not None]
    priced = price_cart(company, lines, customer=layby.customer) if lines else None

    sale = Sale(
        company_id=company.id,
        user_id=user.id,
        customer_id=layby.customer_id,
        number=next_sale_number(company),
        status="completed",
        subtotal_cents=priced["subtotal_cents"] if priced else (layby.total_cents or 0),
        discount_cents=0,
        tax_cents=priced["tax_cents"] if priced else 0,
        total_cents=layby.total_cents,
        paid_cents=layby.paid_cents,
        change_cents=max(0, (layby.paid_cents or 0) - (layby.total_cents or 0)),
        cost_cents=sum(int(round((item.product.cost_cents or 0) * item.qty)) for item in layby.items if item.product),
        note=f"Lay-by {layby.number} settled" + (f" · {layby.note}" if layby.note else ""),
        source="layby",
    )
    db.session.add(sale)

    if priced:
        for line in priced["lines"]:
            product = line["product"]
            sale.items.append(
                SaleItem(
                    product_id=product.id,
                    name=product.name,
                    sku=product.sku,
                    qty=float(line["qty"]),
                    unit_price_cents=line["unit_price_cents"],
                    discount_cents=0,
                    tax_rate_percent=line["tax_rate_percent"],
                    tax_cents=line["tax_cents"],
                    line_subtotal_cents=line["line_subtotal_cents"],
                    line_total_cents=line["line_total_cents"],
                    cost_cents=line["cost_cents"],
                )
            )

    for payment in layby.payments:
        sale.payments.append(
            SalePayment(
                method_id=payment.method_id,
                method_name=payment.method_name,
                method_type=payment.method_type,
                amount_cents=payment.amount_cents,
                tendered_cents=payment.amount_cents,
                reference=payment.reference,
                created_at=payment.created_at,
            )
        )

    if layby.customer is not None:
        layby.customer.total_spent_cents = (layby.customer.total_spent_cents or 0) + (layby.total_cents or 0)
        layby.customer.visits = (layby.customer.visits or 0) + 1
        layby.customer.last_visit_at = utcnow()

    layby.status = "completed"
    layby.completed_at = utcnow()
    layby.sale_id = sale.id
    db.session.commit()
    return sale


def cancel_layby(company, user, layby: Layby, payload: dict) -> dict:
    require_module(company)
    if layby.status != "active":
        raise bad_request("Only active lay-bys can be cancelled.")

    cfg = _config(company)
    reason = (payload.get("reason") or "").strip()
    if not reason:
        raise bad_request("Tell us why this lay-by is being cancelled.", {"reason": "A reason is required."})

    restock = payload.get("restock")
    if restock is None:
        restock = bool(cfg.get("restock_on_cancel", True))

    fee_percent = float(cfg.get("cancellation_fee_percent", 0) or 0)
    forfeited = int(round((layby.paid_cents or 0) * fee_percent / 100))
    refund_due = max(0, (layby.paid_cents or 0) - forfeited)

    if restock:
        for item in layby.items:
            if item.product is None or not item.product.track_stock:
                continue
            product = item.product
            product.stock_qty = round((product.stock_qty or 0) + float(item.qty), 3)
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=user.id,
                    qty_delta=float(item.qty),
                    balance_after=product.stock_qty,
                    reason="layby_cancel",
                    reference=layby.number,
                )
            )

    layby.status = "cancelled"
    layby.cancelled_at = utcnow()
    layby.cancellation_reason = reason[:240]
    layby.forfeited_cents = forfeited
    if layby.customer is not None and refund_due:
        layby.customer.credit_balance_cents = (layby.customer.credit_balance_cents or 0) + refund_due
    db.session.commit()
    return {
        "layby": layby,
        "forfeited_cents": forfeited,
        "refund_due_cents": refund_due,
        "restocked": bool(restock),
    }


def layby_summary(company) -> dict:
    rows = Layby.query.filter_by(company_id=company.id).all()
    active = [row for row in rows if row.status == "active"]
    overdue = [row for row in active if row.due_date and row.due_date < utcnow()]
    return {
        "active": len(active),
        "overdue": len(overdue),
        "completed": sum(1 for row in rows if row.status == "completed"),
        "cancelled": sum(1 for row in rows if row.status == "cancelled"),
        "reserved_value_cents": sum(row.total_cents or 0 for row in active),
        "outstanding_cents": sum(row.balance_cents for row in active),
        "collected_cents": sum(row.paid_cents or 0 for row in active),
    }


def layby_statement_data(layby: Layby) -> dict:
    return {
        "item": layby.to_dict(detail=True),
        "generated_at": iso(utcnow()),
    }
