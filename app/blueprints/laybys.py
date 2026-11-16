"""Lay-by API: create agreements, take instalments, settle or cancel."""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request

from app.blueprints.helpers import get_scoped
from app.extensions import db
from app.models import Customer, Layby, PaymentMethod
from app.security import (
    audit,
    bad_request,
    company_required,
    current_company,
    current_user,
    login_required,
    module_required,
    permission_required,
)
from app.services.laybys import (
    add_payment,
    cancel_layby,
    complete_layby,
    create_layby,
    layby_summary,
)
from app.services.receipt import render_layby_statement
from app.utils import paginate, search_arg, validate

bp = Blueprint("laybys", __name__, url_prefix="/api/laybys")


@bp.get("")
@login_required
@company_required
@module_required("layby")
def list_laybys():
    company = current_company()
    query = Layby.query.filter_by(company_id=company.id)
    status = request.args.get("status")
    if status:
        query = query.filter(Layby.status == status)
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.outerjoin(Customer, Customer.id == Layby.customer_id).filter(
            db.or_(Layby.number.ilike(like), Customer.name.ilike(like), Customer.phone.ilike(like))
        )
    items, meta = paginate(query.order_by(Layby.created_at.desc()), default_per_page=25)
    return jsonify(
        {
            "items": [row.to_dict() for row in items],
            "meta": meta,
            "summary": layby_summary(company),
            "payment_methods": [
                method.to_dict()
                for method in PaymentMethod.query.filter_by(company_id=company.id, is_active=True)
                .order_by(PaymentMethod.sort_order)
                .all()
            ],
        }
    )


@bp.post("")
@login_required
@company_required
@module_required("layby")
@permission_required("pos.sell")
def create_layby_route():
    company = current_company()
    payload = request.get_json(silent=True) or {}
    layby = create_layby(company, current_user(), payload)
    audit("layby.created", entity="layby", entity_id=layby.id,
          summary=f"{layby.number} · deposit {layby.deposit_cents / 100:,.2f}",
          meta={"total_cents": layby.total_cents, "due_date": layby.due_date.isoformat() if layby.due_date else None},
          commit=True)
    return jsonify({"item": layby.to_dict(detail=True)}), 201


@bp.get("/<int:layby_id>")
@login_required
@company_required
@module_required("layby")
def get_layby(layby_id: int):
    company = current_company()
    layby = get_scoped(Layby, layby_id, company.id)
    methods = PaymentMethod.query.filter_by(company_id=company.id, is_active=True).all()
    return jsonify({"item": layby.to_dict(detail=True), "payment_methods": [m.to_dict() for m in methods]})


@bp.post("/<int:layby_id>/payments")
@login_required
@company_required
@module_required("layby")
@permission_required("pos.sell")
def add_layby_payment(layby_id: int):
    company = current_company()
    layby = get_scoped(Layby, layby_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "amount": {"type": "money", "required": True, "label": "Amount"},
            "payment_method_id": {"type": "int", "default": None},
            "reference": {"type": "str", "default": "", "max_len": 120},
        },
    )
    updated = add_payment(company, current_user(), layby, payload)
    audit("layby.payment", entity="layby", entity_id=updated.id,
          summary=f"{updated.number} instalment {payload['amount'] / 100:,.2f}",
          meta={"paid_cents": updated.paid_cents}, commit=True)
    return jsonify({"item": updated.to_dict(detail=True)})


@bp.post("/<int:layby_id>/complete")
@login_required
@company_required
@module_required("layby")
@permission_required("pos.sell")
def complete_layby_route(layby_id: int):
    company = current_company()
    layby = get_scoped(Layby, layby_id, company.id)
    sale = complete_layby(company, current_user(), layby)
    audit("layby.completed", entity="layby", entity_id=layby.id,
          summary=f"{layby.number} settled as {sale.number}", commit=True)
    return jsonify({"item": layby.to_dict(detail=True), "sale": sale.to_dict(detail=True)})


@bp.post("/<int:layby_id>/cancel")
@login_required
@company_required
@module_required("layby")
@permission_required("sales.refund")
def cancel_layby_route(layby_id: int):
    company = current_company()
    layby = get_scoped(Layby, layby_id, company.id)
    result = cancel_layby(company, current_user(), layby, request.get_json(silent=True) or {})
    audit("layby.cancelled", entity="layby", entity_id=layby.id,
          summary=f"{layby.number} cancelled · refund {result['refund_due_cents'] / 100:,.2f}",
          meta={"reason": layby.cancellation_reason, "forfeited_cents": result["forfeited_cents"]},
          commit=True)
    return jsonify(
        {
            "item": layby.to_dict(detail=True),
            "forfeited_cents": result["forfeited_cents"],
            "refund_due_cents": result["refund_due_cents"],
            "restocked": result["restocked"],
        }
    )


@bp.get("/<int:layby_id>/statement")
@login_required
@company_required
@module_required("layby")
def layby_statement(layby_id: int):
    company = current_company()
    layby = get_scoped(Layby, layby_id, company.id)
    html = render_layby_statement(company, layby)
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    )
    return response
