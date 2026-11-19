"""Report recipients and on-demand WhatsApp delivery."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from app.blueprints.helpers import get_scoped
from app.extensions import db
from app.models import ReportRecipient
from app.security import (
    ApiError,
    audit,
    bad_request,
    company_required,
    current_company,
    login_required,
    permission_required,
)
from app.services import whatsapp
from app.services.daily_reports import daily_hour, dispatch_company, latest_dispatch
from app.services.executive import build_executive_summary
from app.utils import validate

bp = Blueprint("report_delivery", __name__, url_prefix="/api/company")


def _duplicate(company_id: int, number: str, exclude_id: int | None = None) -> bool:
    query = ReportRecipient.query.filter_by(company_id=company_id, whatsapp_number=number)
    if exclude_id:
        query = query.filter(ReportRecipient.id != exclude_id)
    return query.first() is not None


def _payload():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "user_id": {"type": "int", "required": True, "label": "Teammate"},
            "role_label": {"type": "str", "default": "", "max_len": 80},
            "is_active": {"type": "bool", "default": True},
        },
    )
    return payload


def _teammate(company, user_id: int):
    """Recipients are teammates: their WhatsApp number lives on the team record."""
    from app.models import User

    user = get_scoped(User, user_id, company.id)
    if not user.whatsapp:
        raise bad_request(
            f"{user.full_name} has no WhatsApp number yet. Add it in Team first.",
            {"user_id": "Add their WhatsApp number under Team."},
        )
    return user


@bp.get("/report-recipients")
@login_required
@company_required
@permission_required("settings.manage")
def list_report_recipients():
    company = current_company()
    rows = (
        ReportRecipient.query.filter_by(company_id=company.id)
        .order_by(ReportRecipient.is_active.desc(), ReportRecipient.name)
        .all()
    )
    dispatch = latest_dispatch(company)
    from app.models import User

    linked = {row.user_id for row in rows if row.user_id}
    teammates = [
        {"id": user.id, "name": user.full_name, "whatsapp": user.whatsapp,
         "role": user.role.name if user.role else ""}
        for user in User.query.filter_by(company_id=company.id).order_by(User.full_name).all()
        if user.whatsapp and user.id not in linked and not user.is_developer
    ]
    return jsonify(
        {
            "items": [row.to_dict() for row in rows],
            "teammates": teammates,
            "whatsapp": whatsapp.config_status(),
            "daily_hour": daily_hour(),
            "last_dispatch": dispatch.to_dict() if dispatch else None,
        }
    )


@bp.post("/report-recipients")
@login_required
@company_required
@permission_required("settings.manage")
def create_report_recipient():
    company = current_company()
    payload = _payload()
    user = _teammate(company, payload["user_id"])
    existing = ReportRecipient.query.filter_by(company_id=company.id, user_id=user.id).first()
    if existing is not None:
        raise bad_request(
            f"{user.full_name} already receives reports.",
            {"user_id": "Already a recipient."},
        )
    if _duplicate(company.id, user.whatsapp):
        raise bad_request(
            "That WhatsApp number already receives reports.",
            {"user_id": "That number is already subscribed."},
        )
    row = ReportRecipient(
        company_id=company.id,
        user_id=user.id,
        name=user.full_name,
        whatsapp_number=user.whatsapp,
        email=user.email or "",
        role_label=payload.get("role_label") or (user.role.name if user.role else ""),
        is_active=payload.get("is_active", True),
    )
    db.session.add(row)
    db.session.commit()
    audit("report_recipient.created", entity="report_recipient", entity_id=row.id,
          summary=f"Added report recipient {row.name}", commit=True)
    return jsonify({"item": row.to_dict()}), 201


@bp.patch("/report-recipients/<int:recipient_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_report_recipient(recipient_id: int):
    company = current_company()
    row = get_scoped(ReportRecipient, recipient_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "role_label": {"type": "str", "max_len": 80},
            "is_active": {"type": "bool"},
        },
    )
    for key, value in payload.items():
        setattr(row, key, value)
    db.session.commit()
    audit("report_recipient.updated", entity="report_recipient", entity_id=row.id,
          summary=f"Updated report recipient {row.name}", commit=True)
    return jsonify({"item": row.to_dict()})


@bp.delete("/report-recipients/<int:recipient_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_report_recipient(recipient_id: int):
    company = current_company()
    row = get_scoped(ReportRecipient, recipient_id, company.id)
    db.session.delete(row)
    db.session.commit()
    audit("report_recipient.deleted", entity="report_recipient", entity_id=recipient_id,
          summary=f"Removed report recipient {row.name}", commit=True)
    return jsonify({"ok": True})


@bp.get("/report-recipients/preview")
@login_required
@company_required
@permission_required("settings.manage")
def preview_executive_report():
    company = current_company()
    report = build_executive_summary(company)
    return jsonify(
        {
            "text": report["text"],
            "generated_at": report["generated_at"],
            "local_date": report["local_date"],
            "advice": report["advice"],
            "whatsapp": whatsapp.config_status(),
            "daily_hour": daily_hour(),
        }
    )


@bp.post("/report-recipients/<int:recipient_id>/test")
@login_required
@company_required
@permission_required("settings.manage")
def test_report_recipient(recipient_id: int):
    company = current_company()
    row = get_scoped(ReportRecipient, recipient_id, company.id)
    try:
        responses = whatsapp.send_test_message(row.whatsapp_number, company.name)
    except whatsapp.WhatsAppError as error:
        raise ApiError(str(error), 502, "whatsapp_error") from error
    return jsonify({"ok": True, "provider_ids": [item.get("id") for item in responses]})


@bp.post("/report-recipients/send-now")
@login_required
@company_required
@permission_required("settings.manage")
def send_report_now():
    company = current_company()
    payload = request.get_json(silent=True) or {}
    result = dispatch_company(
        company,
        force=bool(payload.get("force", True)),
        dry_run=bool(payload.get("dry_run", False)),
    )
    if result.get("status") == "not_configured":
        raise ApiError(
            "WhatsApp is not connected yet. Add WHATSAPP_PHONE_NUMBER_ID and "
            "WHATSAPP_ACCESS_TOKEN to the server environment.",
            503,
            "whatsapp_not_configured",
        )
    return jsonify(result)
