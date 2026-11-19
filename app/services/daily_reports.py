"""Scheduling and delivery of the daily executive summary."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models import Company, ReportDispatch, ReportRecipient
from app.services import whatsapp
from app.services.executive import build_executive_summary
from app.services.timezones import to_local
from app.utils import utcnow

LOG = logging.getLogger(__name__)

DAILY_HOUR = 18
RETRY_AFTER_MINUTES = 15


def daily_hour() -> int:
    try:
        from flask import current_app

        return int(current_app.config.get("DAILY_REPORT_HOUR", DAILY_HOUR) or DAILY_HOUR)
    except (RuntimeError, TypeError, ValueError):
        return DAILY_HOUR


def active_recipients(company) -> list[ReportRecipient]:
    return (
        ReportRecipient.query.filter_by(company_id=company.id, is_active=True)
        .order_by(ReportRecipient.name)
        .all()
    )


def latest_dispatch(company, report_date=None) -> ReportDispatch | None:
    query = ReportDispatch.query.filter_by(company_id=company.id, channel="whatsapp")
    if report_date is not None:
        query = query.filter_by(report_date=report_date)
    return query.order_by(ReportDispatch.report_date.desc(), ReportDispatch.id.desc()).first()


def _claim(company, report_date) -> tuple[ReportDispatch, bool]:
    row = ReportDispatch.query.filter_by(
        company_id=company.id, report_date=report_date, channel="whatsapp"
    ).first()
    if row is not None:
        return row, False
    row = ReportDispatch(
        company_id=company.id,
        report_date=report_date,
        channel="whatsapp",
        status="sending",
        details=[],
    )
    db.session.add(row)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        row = ReportDispatch.query.filter_by(
            company_id=company.id, report_date=report_date, channel="whatsapp"
        ).first()
        return row, False
    return row, True


def _stale(row: ReportDispatch) -> bool:
    stamp = row.updated_at or row.created_at
    return not stamp or utcnow() - stamp > timedelta(minutes=RETRY_AFTER_MINUTES)


def dispatch_company(
    company,
    *,
    at: datetime | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict:
    """Send one company's report once, retrying only failed recipients."""
    now = at or utcnow()
    local = to_local(now, company)
    report_date = local.date() if isinstance(local, datetime) else now.date()
    recipients = active_recipients(company)
    if not recipients:
        return {
            "company": company.name,
            "status": "skipped",
            "reason": "No active report recipients.",
            "report_date": report_date.isoformat(),
        }

    status = whatsapp.config_status()
    if dry_run or status["dry_run"]:
        report = build_executive_summary(company, at=now)
        if dry_run:
            return {
                "company": company.name,
                "status": "dry_run",
                "report_date": report_date.isoformat(),
                "recipients": [recipient.whatsapp_number for recipient in recipients],
                "text": report["text"],
                "config": status,
            }
    if not status["configured"] and not status["dry_run"]:
        return {
            "company": company.name,
            "status": "not_configured",
            "reason": "WhatsApp credentials are not set on this server.",
            "report_date": report_date.isoformat(),
        }

    row, freshly_claimed = _claim(company, report_date)
    if row is None:
        return {"company": company.name, "status": "error", "reason": "Could not claim dispatch."}
    if row.status == "sent" and not force:
        return {
            "company": company.name,
            "status": "already_sent",
            "report_date": report_date.isoformat(),
            "delivered": row.delivered_count,
        }
    if row.status == "sending" and not freshly_claimed and not _stale(row):
        return {
            "company": company.name,
            "status": "in_progress",
            "report_date": report_date.isoformat(),
        }

    try:
        report = build_executive_summary(company, at=now)
    except Exception as error:  # a broken report must not leave a stuck claim
        row.status = "failed"
        row.summary = f"Report build failed: {str(error)[:180]}"
        db.session.commit()
        LOG.exception("Executive summary build failed for %s", company.name)
        return {
            "company": company.name,
            "status": "failed",
            "reason": str(error)[:240],
            "report_date": report_date.isoformat(),
        }
    details = [] if force else list(row.details or [])
    completed_statuses = {"sent", "dry_run"} if status["dry_run"] else {"sent"}
    delivered_ids = {
        str(item.get("recipient_id"))
        for item in details
        if item.get("status") in completed_statuses and item.get("recipient_id")
    }
    if not status["dry_run"]:
        details = [item for item in details if item.get("status") != "dry_run"]
    by_id = {str(recipient.id): recipient for recipient in recipients}
    details = [item for item in details if str(item.get("recipient_id")) in by_id]
    pending = [recipient for recipient in recipients if str(recipient.id) not in delivered_ids]

    for recipient in pending:
        try:
            responses = whatsapp.send_text(recipient.whatsapp_number, report["text"])
            detail = {
                "recipient_id": recipient.id,
                "name": recipient.name,
                "number": whatsapp.mask_number(recipient.whatsapp_number),
                "status": "dry_run" if status["dry_run"] else "sent",
                "provider_ids": [item.get("id") for item in responses if item.get("id")],
            }
            recipient.last_status = detail["status"]
            recipient.last_error = ""
            recipient.last_sent_at = utcnow()
        except Exception as error:  # one bad number must not block the rest
            message = str(error)[:240]
            detail = {
                "recipient_id": recipient.id,
                "name": recipient.name,
                "number": whatsapp.mask_number(recipient.whatsapp_number),
                "status": "failed",
                "error": message,
            }
            recipient.last_status = "failed"
            recipient.last_error = message
            LOG.warning("WhatsApp report to %s failed: %s", recipient.name, message)
        details.append(detail)

    delivered = sum(1 for item in details if item.get("status") in {"sent", "dry_run"})
    failed = sum(1 for item in details if item.get("status") == "failed")
    row.recipient_count = len(recipients)
    row.delivered_count = delivered
    row.failed_count = failed
    if failed and delivered:
        row.status = "partial"
    elif failed:
        row.status = "failed"
    elif status["dry_run"]:
        row.status = "dry_run"
    else:
        row.status = "sent"
        row.sent_at = utcnow()
    row.details = details
    row.summary = (
        f"Sent to {delivered} of {len(recipients)} recipient"
        f"{'s' if len(recipients) != 1 else ''}"
        + (f" · {failed} failed" if failed else "")
    )
    db.session.commit()
    return {
        "company": company.name,
        "status": row.status,
        "report_date": report_date.isoformat(),
        "delivered": delivered,
        "failed": failed,
        "recipients": len(recipients),
        "text": report["text"] if dry_run or status["dry_run"] else "",
    }


def companies_to_notify(company_id: int | None = None):
    query = Company.query.filter(Company.status.in_(("active", "trial")))
    if company_id:
        query = query.filter(Company.id == company_id)
    return query.order_by(Company.id).all()


def dispatch_due(
    *,
    now: datetime | None = None,
    force: bool = False,
    dry_run: bool = False,
    company_id: int | None = None,
) -> list[dict]:
    """Send to every eligible company whose local clock has reached 18:00."""
    at = now or utcnow()
    results: list[dict] = []
    for company in companies_to_notify(company_id):
        local = to_local(at, company)
        if not force and (not isinstance(local, datetime) or local.hour < daily_hour()):
            continue
        if not force and local.hour > 23:
            continue
        if not active_recipients(company):
            continue
        results.append(dispatch_company(company, at=at, force=force, dry_run=dry_run))
    return results


def start_scheduler(app) -> None:  # pragma: no cover - long-running wrapper
    """Start a small daemon that checks every two minutes.

    Render runs several gunicorn workers; the unique report-dispatch row makes
    the check idempotent so only one worker actually sends.
    """
    import threading
    import time

    if getattr(app, "_report_scheduler_started", False):
        return
    app._report_scheduler_started = True

    def loop():
        time.sleep(15)
        while True:
            try:
                with app.app_context():
                    results = dispatch_due()
                    if results:
                        LOG.info("Daily reports: %s", [(row.get("company"), row.get("status")) for row in results])
                    db.session.remove()
            except Exception:  # keep the worker alive; next tick retries
                LOG.exception("Daily report scheduler failed")
                try:
                    db.session.remove()
                except Exception:
                    pass
            time.sleep(120)

    threading.Thread(target=loop, name="daily-report-scheduler", daemon=True).start()
