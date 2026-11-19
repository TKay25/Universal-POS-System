"""Workspace activity log — everything anyone did, from the audit trail."""

from __future__ import annotations

from collections import Counter

from flask import Blueprint, jsonify, request

from app.extensions import db
from app.models import AuditLog, retention_cutoff
from app.security import company_required, current_company, login_required, module_required, permission_required
from app.utils import paginate, parse_date, search_arg

bp = Blueprint("activity", __name__, url_prefix="/api/activity")


def _retained(query, company):
    """Hide entries older than the audit log retention the workspace configured."""
    days = int(company.module_config("audit_log").get("retention_days", 365) or 365)
    return query.filter(AuditLog.created_at >= retention_cutoff(days))


def _bounds(company):
    """Optional local date filter; omit both ends to see the whole history."""
    start_day = parse_date(request.args.get("from"))
    end_day = parse_date(request.args.get("to"))
    if not start_day and not end_day:
        return None
    from app.services.timezones import local_range_bounds

    return local_range_bounds(start_day or end_day, end_day or start_day, company)


@bp.get("")
@login_required
@company_required
@module_required("audit_log")
@permission_required("audit.view")
def activity_feed():
    company = current_company()
    query = _retained(AuditLog.query.filter(AuditLog.company_id == company.id), company)

    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(
            db.or_(
                AuditLog.action.ilike(like),
                AuditLog.summary.ilike(like),
                AuditLog.actor_name.ilike(like),
                AuditLog.actor_email.ilike(like),
                AuditLog.entity.ilike(like),
            )
        )

    area = (request.args.get("area") or "").strip()
    if area:
        query = query.filter(AuditLog.action.like(f"{area}.%"))
    entity = (request.args.get("entity") or "").strip()
    if entity:
        query = query.filter(AuditLog.entity == entity)
    actor = request.args.get("actor", type=int)
    if actor:
        query = query.filter(AuditLog.user_id == actor)

    bounds = _bounds(company)
    if bounds:
        query = query.filter(AuditLog.created_at >= bounds[0], AuditLog.created_at <= bounds[1])

    items, meta = paginate(query.order_by(AuditLog.created_at.desc()), default_per_page=40)
    return jsonify({"items": [entry.to_dict() for entry in items], "meta": meta})


@bp.get("/facets")
@login_required
@company_required
@module_required("audit_log")
@permission_required("audit.view")
def activity_facets():
    """Filter options: areas, entities and the people who did things."""
    company = current_company()
    cutoff = retention_cutoff(int(company.module_config("audit_log").get("retention_days", 365) or 365))
    actions = db.session.execute(
        db.select(AuditLog.action)
        .where(AuditLog.company_id == company.id, AuditLog.created_at >= cutoff)
        .group_by(AuditLog.action)
    ).scalars().all()
    areas = Counter((action or "").split(".")[0] for action in actions if action)

    entities = db.session.execute(
        db.select(AuditLog.entity)
        .where(AuditLog.company_id == company.id, AuditLog.entity != "", AuditLog.created_at >= cutoff)
        .group_by(AuditLog.entity)
        .order_by(AuditLog.entity)
    ).scalars().all()

    actor_rows = db.session.execute(
        db.select(AuditLog.user_id, AuditLog.actor_name, AuditLog.actor_email, db.func.count(AuditLog.id))
        .where(AuditLog.company_id == company.id, AuditLog.user_id.isnot(None), AuditLog.created_at >= cutoff)
        .group_by(AuditLog.user_id, AuditLog.actor_name, AuditLog.actor_email)
        .order_by(db.func.count(AuditLog.id).desc())
        .limit(30)
    ).all()

    return jsonify(
        {
            "areas": [{"key": key, "count": count} for key, count in areas.most_common()],
            "entities": [entity for entity in entities if entity],
            "actors": [
                {
                    "id": row[0],
                    "name": row[1] or row[2] or "System",
                    "email": row[2],
                    "count": int(row[3]),
                }
                for row in actor_rows
            ],
        }
    )
