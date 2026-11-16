"""Point of sale: bootstrap, checkout, sales history, refunds, holds and shifts."""

from __future__ import annotations

from datetime import datetime

from flask import Blueprint, Response, jsonify, request

from app.blueprints.helpers import get_scoped
from app.extensions import db
from app.models import (
    Category,
    Customer,
    Department,
    HeldCart,
    Location,
    PaymentMethod,
    Product,
    Register,
    Sale,
    Shift,
    TaxRate,
)
from app.security import (
    ApiError,
    audit,
    bad_request,
    company_required,
    current_company,
    current_user,
    forbidden,
    login_required,
    not_found,
    permission_required,
)
from app.services.checkout import (
    close_shift,
    complete_sale,
    current_shift,
    open_shift,
    refund_sale,
    shift_cash_summary,
    void_sale,
)
from app.services.receipt import render_receipt
from app.utils import paginate, parse_date, search_arg, validate

bp = Blueprint("sales", __name__, url_prefix="/api")


# --------------------------------------------------------------------------- #
# POS bootstrap
# --------------------------------------------------------------------------- #
@bp.get("/pos/bootstrap")
@login_required
@company_required
@permission_required("pos.sell")
def pos_bootstrap():
    company = current_company()
    user = current_user()
    pos_cfg = company.module_config("pos")
    show_out_of_stock = bool(company.settings.get("sales", {}).get("show_out_of_stock", True))

    products = Product.query.filter_by(company_id=company.id, is_active=True).order_by(Product.name).all()
    if not show_out_of_stock:
        products = [
            p for p in products
            if not p.track_stock or p.stock_qty > 0 or company.module_config("inventory").get("allow_negative")
        ]

    categories = (
        Category.query.filter_by(company_id=company.id, is_active=True)
        .order_by(Category.sort_order, Category.name)
        .all()
    )
    departments = (
        Department.query.filter_by(company_id=company.id, is_active=True)
        .order_by(Department.sort_order, Department.name)
        .all()
    )
    methods = (
        PaymentMethod.query.filter_by(company_id=company.id, is_active=True)
        .order_by(PaymentMethod.sort_order, PaymentMethod.name)
        .all()
    )
    taxes = TaxRate.query.filter_by(company_id=company.id, is_active=True).all()
    held = HeldCart.query.filter_by(company_id=company.id).order_by(HeldCart.created_at.desc()).limit(30).all()
    shift = current_shift(company, user)
    locations = Location.query.filter_by(company_id=company.id, is_active=True).all()
    registers = Register.query.filter_by(company_id=company.id, is_active=True).all()

    module_config = {
        key: company.module_config(key)
        for key in (
            "pos", "barcode", "discounts", "tips", "service_charge", "loyalty",
            "order_notes", "receipts", "shifts", "refunds", "price_overrides",
            "inventory", "customers", "tax_engine", "rounding", "holders",
            "departments", "layby", "bulk_stock",
        )
    }

    return jsonify(
        {
            "products": [p.to_dict() for p in products],
            "categories": [c.to_dict() for c in categories],
            "departments": [d.to_dict() for d in departments],
            "payment_methods": [m.to_dict() for m in methods],
            "taxes": [t.to_dict() for t in taxes],
            "held_carts": [h.to_dict() for h in held],
            "shift": shift.to_dict() if shift else None,
            "locations": [l.to_dict() for l in locations],
            "registers": [r.to_dict() for r in registers],
            "settings": {
                "currency": company.settings.get("currency", {}),
                "branding": company.settings.get("branding", {}),
                "sales": company.settings.get("sales", {}),
            },
            "modules": {key: company.module_enabled(key) for key in module_config},
            "config": module_config,
            "cashier": user.to_dict(include_company=False),
            "staff": [
                u.to_dict(include_company=False)
                for u in company.users
                if u.status == "active"
            ],
            "delivery": {"tax_inclusive": bool(company.module_config("tax_engine").get("prices_include_tax"))},
        }
    )


# --------------------------------------------------------------------------- #
# Checkout
# --------------------------------------------------------------------------- #
@bp.post("/sales")
@login_required
@company_required
@permission_required("pos.sell")
def create_sale():
    company = current_company()
    user = current_user()
    payload = request.get_json(silent=True) or {}

    shift_cfg = company.module_config("shifts")
    shift = current_shift(company, user)
    if company.module_enabled("shifts") and shift_cfg.get("require_open_shift") and shift is None:
        raise ApiError("Open a shift before taking payments.", 409, "shift_required")
    if shift is not None and not payload.get("shift_id"):
        payload["shift_id"] = shift.id
    if not payload.get("location_id"):
        default_location = Location.query.filter_by(company_id=company.id, is_default=True).first()
        if default_location is not None:
            payload["location_id"] = default_location.id
    if not payload.get("register_id"):
        register = Register.query.filter_by(company_id=company.id, is_active=True).first()
        if register is not None:
            payload["register_id"] = register.id

    sale = complete_sale(company, user, payload)
    audit("sale.completed", entity="sale", entity_id=sale.id,
          summary=f"{sale.number} · {sale.total_cents / 100:,.2f}",
          meta={"total_cents": sale.total_cents, "items": len(sale.items)}, commit=True)
    return jsonify({"item": sale.to_dict(detail=True)}), 201


@bp.get("/sales")
@login_required
@company_required
def list_sales():
    company = current_company()
    user = current_user()
    query = Sale.query.filter_by(company_id=company.id)

    if not user.has_permission("sales.view_all"):
        query = query.filter(Sale.user_id == user.id)

    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.outerjoin(Customer, Customer.id == Sale.customer_id).filter(
            db.or_(Sale.number.ilike(like), Customer.name.ilike(like))
        )
    status = request.args.get("status")
    if status:
        query = query.filter(Sale.status == status)
    start_day = parse_date(request.args.get("from"))
    end_day = parse_date(request.args.get("to"))
    if start_day or end_day:
        from app.services.timezones import local_range_bounds

        today = __import__("datetime").datetime.utcnow().date()
        start_utc, end_utc = local_range_bounds(start_day or end_day, end_day or start_day, company)
        query = query.filter(Sale.created_at >= start_utc, Sale.created_at <= end_utc)
    if request.args.get("mine") == "1":
        query = query.filter(Sale.user_id == user.id)
    if request.args.get("shift_id"):
        query = query.filter(Sale.shift_id == request.args.get("shift_id", type=int))

    items, meta = paginate(query.order_by(Sale.created_at.desc()), default_per_page=25)
    return jsonify({"items": [s.to_dict() for s in items], "meta": meta})


@bp.get("/sales/<int:sale_id>")
@login_required
@company_required
def get_sale(sale_id: int):
    company = current_company()
    user = current_user()
    sale = get_scoped(Sale, sale_id, company.id)
    if not user.has_permission("sales.view_all") and sale.user_id != user.id:
        forbidden("You can only open your own sales.")
    return jsonify({"item": sale.to_dict(detail=True)})


@bp.get("/sales/<int:sale_id>/receipt")
@login_required
@company_required
def sale_receipt(sale_id: int):
    company = current_company()
    user = current_user()
    sale = get_scoped(Sale, sale_id, company.id)
    if not user.has_permission("sales.view_all") and sale.user_id != user.id:
        forbidden("You can only print your own receipts.")
    auto_print = request.args.get("auto_print") == "1"
    html = render_receipt(company, sale, auto_print=auto_print)
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    )
    return response


@bp.get("/sales/<int:sale_id>/receipt.json")
@login_required
@company_required
def sale_receipt_data(sale_id: int):
    company = current_company()
    user = current_user()
    sale = get_scoped(Sale, sale_id, company.id)
    if not user.has_permission("sales.view_all") and sale.user_id != user.id:
        forbidden("You can only print your own receipts.")
    return jsonify(
        {
            "item": sale.to_dict(detail=True),
            "company": company.to_dict(detail=True),
            "receipt": company.module_config("receipts"),
        }
    )


@bp.post("/sales/<int:sale_id>/refund")
@login_required
@company_required
@permission_required("sales.refund")
def refund(sale_id: int):
    company = current_company()
    sale = get_scoped(Sale, sale_id, company.id)
    payload = request.get_json(silent=True) or {}
    refund_row = refund_sale(company, current_user(), sale, payload)
    audit("sale.refunded", entity="sale", entity_id=sale.id,
          summary=f"{sale.number} refunded {refund_row.amount_cents / 100:,.2f}",
          meta={"amount_cents": refund_row.amount_cents, "reason": refund_row.reason,
                "method": refund_row.method}, commit=True)
    return jsonify({"item": refund_row.to_dict(), "sale": sale.to_dict(detail=True)})


@bp.post("/sales/<int:sale_id>/void")
@login_required
@company_required
@permission_required("sales.void")
def void(sale_id: int):
    company = current_company()
    sale = get_scoped(Sale, sale_id, company.id)
    reason = (request.get_json(silent=True) or {}).get("reason", "")
    void_sale(company, current_user(), sale, reason)
    audit("sale.voided", entity="sale", entity_id=sale.id,
          summary=f"{sale.number} voided", meta={"reason": reason}, commit=True)
    return jsonify({"item": sale.to_dict(detail=True)})


@bp.post("/sales/lookup-receipt")
@login_required
@company_required
def lookup_receipt():
    company = current_company()
    number = (request.get_json(silent=True) or {}).get("number", "").strip()
    if not number:
        raise bad_request("Enter a receipt number.")
    sale = Sale.query.filter_by(company_id=company.id, number=number).first()
    if sale is None:
        not_found("No sale matches that receipt number.")
    return jsonify({"item": sale.to_dict(detail=True)})


@bp.post("/discounts/validate")
@login_required
@company_required
def validate_discount():
    """Check a promotion code so the till can preview the saving."""
    from app.models import Discount

    company = current_company()
    code = str((request.get_json(silent=True) or {}).get("code", "")).strip().upper()
    if not code:
        raise bad_request("Enter a promotion code.")
    discount = Discount.query.filter_by(company_id=company.id, code=code).first()
    if discount is None or not discount.is_valid_now():
        raise bad_request("That promotion code is not valid.")
    payload = discount.to_dict()
    payload["type"] = discount.type
    payload["value"] = discount.value
    payload["label"] = discount.name
    return jsonify({"item": payload})


# --------------------------------------------------------------------------- #
# Held carts
# --------------------------------------------------------------------------- #
@bp.get("/holds")
@login_required
@company_required
def list_holds():
    company = current_company()
    rows = HeldCart.query.filter_by(company_id=company.id).order_by(HeldCart.created_at.desc()).all()
    return jsonify({"items": [h.to_dict() for h in rows]})


@bp.post("/holds")
@login_required
@company_required
@permission_required("pos.sell")
def create_hold():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "default": "Held order", "max_len": 120},
            "payload": {"type": "json", "required": True},
        },
    )
    hold = HeldCart(
        company_id=company.id,
        user_id=current_user().id,
        name=payload["name"],
        payload=payload["payload"],
    )
    db.session.add(hold)
    db.session.commit()
    audit("cart.held", entity="held_cart", entity_id=hold.id, summary=f"Parked {hold.name}", commit=True)
    return jsonify({"item": hold.to_dict()}), 201


@bp.delete("/holds/<int:hold_id>")
@login_required
@company_required
@permission_required("pos.sell")
def delete_hold(hold_id: int):
    company = current_company()
    hold = get_scoped(HeldCart, hold_id, company.id)
    db.session.delete(hold)
    db.session.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Shifts
# --------------------------------------------------------------------------- #
@bp.get("/shifts")
@login_required
@company_required
def list_shifts():
    company = current_company()
    query = Shift.query.filter_by(company_id=company.id)
    if not current_user().has_permission("reports.view"):
        query = query.filter(Shift.user_id == current_user().id)
    items, meta = paginate(query.order_by(Shift.opened_at.desc()), default_per_page=25)
    return jsonify({"items": [s.to_dict() for s in items], "meta": meta})


@bp.get("/shifts/current")
@login_required
@company_required
def get_current_shift():
    company = current_company()
    shift = current_shift(company, current_user())
    if shift is None:
        return jsonify({"item": None})
    summary = shift_cash_summary(company, shift)
    return jsonify({"item": shift.to_dict(), "summary": summary})


@bp.post("/shifts/open")
@login_required
@company_required
@permission_required("shifts.manage")
def open_shift_route():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "opening_float": {"type": "money", "default": 0},
            "register_id": {"type": "int", "default": None},
            "notes": {"type": "str", "default": "", "max_len": 2000},
        },
    )
    shift = open_shift(
        company,
        current_user(),
        register_id=payload["register_id"],
        opening_float_cents=payload["opening_float"],
        notes=payload["notes"],
    )
    audit("shift.opened", entity="shift", entity_id=shift.id,
          summary=f"Shift opened with {shift.opening_float_cents / 100:,.2f} float", commit=True)
    return jsonify({"item": shift.to_dict()}), 201


@bp.post("/shifts/<int:shift_id>/close")
@login_required
@company_required
@permission_required("shifts.manage")
def close_shift_route(shift_id: int):
    company = current_company()
    shift = get_scoped(Shift, shift_id, company.id)
    user = current_user()
    if shift.user_id != user.id and not user.has_permission("settings.manage"):
        forbidden("Only the cashier or a manager can close this shift.")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "counted_cash": {"type": "money", "default": None},
            "notes": {"type": "str", "default": "", "max_len": 2000},
        },
    )
    close_shift(company, shift, counted_cash_cents=payload["counted_cash"], notes=payload["notes"])
    audit("shift.closed", entity="shift", entity_id=shift.id,
          summary=f"Shift closed, variance {shift.variance_cents / 100:,.2f}", commit=True)
    return jsonify({"item": shift.to_dict()})
