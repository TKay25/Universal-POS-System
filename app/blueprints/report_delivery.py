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


def _normalise_or_error(raw, field: str = "whatsapp_number") -> str:
    try:
        return whatsapp.normalise_number(raw)
    except ValueError as error:
        raise bad_request(str(error), {field: str(error)}) from error


def _duplicate(company_id: int, number: str, exclude_id: int | None = None) -> bool:
    query = ReportRecipient.query.filter_by(company_id=company_id, whatsapp_number=number)
    if exclude_id:
        query = query.filter(ReportRecipient.id != exclude_id)
    return query.first() is not None


def _payload():
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "min_len": 2, "max_len": 120, "label": "Name"},
            "whatsapp_number": {"type": "str", "required": True, "max_len": 40, "label": "WhatsApp number"},
            "email": {"type": "str", "default": "", "max_len": 180},
            "role_label": {"type": "str", "default": "", "max_len": 80},
            "is_active": {"type": "bool", "default": True},
        },
    )
    payload["whatsapp_number"] = _normalise_or_error(payload["whatsapp_number"])
    return payload


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
    return jsonify(
        {
            "items": [row.to_dict() for row in rows],
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
    if _duplicate(company.id, payload["whatsapp_number"]):
        raise bad_request(
            "That WhatsApp number already receives reports.",
            {"whatsapp_number": "Already subscribed."},
        )
    row = ReportRecipient(company_id=company.id, **payload)
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
            "name": {"type": "str", "min_len": 2, "max_len": 120},
            "whatsapp_number": {"type": "str", "max_len": 40},
            "email": {"type": "str", "max_len": 180},
            "role_label": {"type": "str", "max_len": 80},
            "is_active": {"type": "bool"},
        },
    )
    if "whatsapp_number" in payload:
        payload["whatsapp_number"] = _normalise_or_error(payload["whatsapp_number"])
        if _duplicate(company.id, payload["whatsapp_number"], exclude_id=row.id):
            raise bad_request(
                "That WhatsApp number already receives reports.",
                {"whatsapp_number": "Already subscribed."},
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
