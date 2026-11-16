"""Company-defined custom workspaces: user-built tabs with their own forms."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from app.blueprints.helpers import get_scoped
from app.extensions import db
from app.models import CustomWorkspace, WorkspaceRecord
from app.security import (
    audit,
    bad_request,
    company_required,
    current_company,
    current_user,
    login_required,
    permission_required,
)
from app.utils import csv_response, paginate, search_arg, utcnow, validate

bp = Blueprint("workspaces", __name__, url_prefix="/api/workspaces")

FIELD_TYPES = ["text", "textarea", "number", "date", "select", "bool"]


def _clean_fields(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise bad_request("Workspace fields must be a list.", {"fields": "Invalid field list."})
    fields: list[dict] = []
    seen: set[str] = set()
    for index, field in enumerate(raw[:20]):
        if not isinstance(field, dict):
            continue
        label = str(field.get("label", "")).strip()[:80]
        if not label:
            raise bad_request(f"Field {index + 1} needs a label.", {"fields": "Every field needs a label."})
        key = str(field.get("key") or label).strip().lower().replace(" ", "_")[:60]
        key = "".join(ch for ch in key if ch.isalnum() or ch == "_") or f"field_{index}"
        if key in seen:
            key = f"{key}_{index}"
        seen.add(key)
        kind = str(field.get("type", "text"))
        if kind not in FIELD_TYPES:
            kind = "text"
        options = [str(o)[:60] for o in (field.get("options") or [])][:30] if kind == "select" else []
        if kind == "select" and not options:
            raise bad_request(f"Add options for '{label}'.", {"fields": f"{label} needs options."})
        fields.append(
            {
                "key": key,
                "label": label,
                "type": kind,
                "options": options,
                "required": bool(field.get("required")),
            }
        )
    if not fields:
        raise bad_request("Add at least one field.", {"fields": "At least one field is required."})
    return fields


def _require_module():
    company = current_company()
    if not company.module_enabled("custom_workspaces"):
        raise bad_request("Enable the Custom Workspaces module in settings first.")
    return company


@bp.get("")
@login_required
@company_required
def list_workspaces():
    company = _require_module()
    rows = (
        CustomWorkspace.query.filter_by(company_id=company.id)
        .order_by(CustomWorkspace.sort_order, CustomWorkspace.name)
        .all()
    )
    return jsonify({"items": [w.to_dict() for w in rows]})


@bp.post("")
@login_required
@company_required
@permission_required("settings.manage")
def create_workspace():
    company = _require_module()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 80, "label": "Workspace name"},
            "icon": {"type": "str", "default": "sparkles", "max_len": 40},
            "description": {"type": "str", "default": "", "max_len": 240},
            "fields": {"type": "json", "required": True},
            "sort_order": {"type": "int", "default": 100, "min": 0, "max": 9999},
        },
    )
    limit = int(company.module_config("custom_workspaces").get("max_workspaces", 10) or 10)
    if CustomWorkspace.query.filter_by(company_id=company.id).count() >= limit:
        raise bad_request(f"Your plan allows {limit} custom workspaces.")
    workspace = CustomWorkspace(
        company_id=company.id,
        name=payload["name"],
        icon=payload["icon"],
        description=payload["description"],
        fields=_clean_fields(payload["fields"]),
        sort_order=payload["sort_order"],
    )
    db.session.add(workspace)
    db.session.commit()
    audit("workspace.created", entity="workspace", entity_id=workspace.id,
          summary=f"Built workspace {workspace.name}", commit=True)
    return jsonify({"item": workspace.to_dict()}), 201


@bp.patch("/<int:workspace_id>")
@login_required
@company_required
@permission_required("settings.manage")
def update_workspace(workspace_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 80},
            "icon": {"type": "str", "max_len": 40},
            "description": {"type": "str", "max_len": 240},
            "fields": {"type": "json"},
            "is_active": {"type": "bool"},
            "sort_order": {"type": "int", "min": 0, "max": 9999},
        },
    )
    if "fields" in payload:
        workspace.fields = _clean_fields(payload.pop("fields"))
    for key, value in payload.items():
        setattr(workspace, key, value)
    db.session.commit()
    audit("workspace.updated", entity="workspace", entity_id=workspace.id,
          summary=f"Updated workspace {workspace.name}", commit=True)
    return jsonify({"item": workspace.to_dict()})


@bp.delete("/<int:workspace_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_workspace(workspace_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    db.session.delete(workspace)
    db.session.commit()
    audit("workspace.deleted", entity="workspace", entity_id=workspace_id,
          summary=f"Deleted workspace {workspace.name}", commit=True)
    return jsonify({"ok": True})


@bp.get("/<int:workspace_id>/records")
@login_required
@company_required
def list_records(workspace_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    query = WorkspaceRecord.query.filter_by(workspace_id=workspace.id, company_id=company.id)
    term = search_arg()
    if term:
        query = query.filter(db.cast(WorkspaceRecord.data, db.Text).ilike(f"%{term}%"))
    items, meta = paginate(query.order_by(WorkspaceRecord.created_at.desc()), default_per_page=40)
    return jsonify({"workspace": workspace.to_dict(), "items": [r.to_dict() for r in items], "meta": meta})


def _validate_record(workspace: CustomWorkspace, raw) -> dict:
    if not isinstance(raw, dict):
        raise bad_request("Record data must be an object.")
    clean: dict = {}
    errors: dict[str, str] = {}
    for field in workspace.fields or []:
        value = raw.get(field["key"])
        if value in (None, "") and field.get("required"):
            errors[field["key"]] = f"{field['label']} is required."
            continue
        if value in (None, ""):
            continue
        if field["type"] == "number":
            try:
                clean[field["key"]] = float(value)
            except (TypeError, ValueError):
                errors[field["key"]] = f"{field['label']} must be a number."
        elif field["type"] == "bool":
            clean[field["key"]] = bool(value)
        elif field["type"] == "select":
            if str(value) not in field.get("options", []):
                errors[field["key"]] = f"{field['label']} has an invalid option."
            else:
                clean[field["key"]] = str(value)
        else:
            clean[field["key"]] = str(value)[:2000]
    if errors:
        raise bad_request("Please review the highlighted fields.", errors)
    return clean


@bp.post("/<int:workspace_id>/records")
@login_required
@company_required
@permission_required("pos.sell")
def create_record(workspace_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    payload = request.get_json(silent=True) or {}
    record = WorkspaceRecord(
        workspace_id=workspace.id,
        company_id=company.id,
        data=_validate_record(workspace, payload.get("data") or payload),
        created_by=current_user().full_name,
    )
    db.session.add(record)
    db.session.commit()
    audit("workspace.record_created", entity="workspace_record", entity_id=record.id,
          summary=f"New entry in {workspace.name}", commit=True)
    return jsonify({"item": record.to_dict()}), 201


@bp.patch("/<int:workspace_id>/records/<int:record_id>")
@login_required
@company_required
@permission_required("pos.sell")
def update_record(workspace_id: int, record_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    record = get_scoped(WorkspaceRecord, record_id, company.id)
    payload = request.get_json(silent=True) or {}
    record.data = _validate_record(workspace, payload.get("data") or payload)
    db.session.commit()
    return jsonify({"item": record.to_dict()})


@bp.delete("/<int:workspace_id>/records/<int:record_id>")
@login_required
@company_required
@permission_required("settings.manage")
def delete_record(workspace_id: int, record_id: int):
    company = _require_module()
    get_scoped(CustomWorkspace, workspace_id, company.id)
    record = get_scoped(WorkspaceRecord, record_id, company.id)
    db.session.delete(record)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/<int:workspace_id>/records.csv")
@login_required
@company_required
def export_records(workspace_id: int):
    company = _require_module()
    workspace = get_scoped(CustomWorkspace, workspace_id, company.id)
    rows = (
        WorkspaceRecord.query.filter_by(workspace_id=workspace.id, company_id=company.id)
        .order_by(WorkspaceRecord.created_at.desc())
        .all()
    )
    headers = [field["label"] for field in workspace.fields or []] + ["Created", "Created by"]
    data = []
    for record in rows:
        payload = record.data or {}
        data.append(
            [payload.get(field["key"], "") for field in workspace.fields or []]
            + [record.created_at.strftime("%Y-%m-%d %H:%M") if record.created_at else "",
               record.created_by or ""]
        )
    return csv_response(f"{workspace.name.lower().replace(' ', '-')}-{utcnow().date()}.csv", headers, data)
