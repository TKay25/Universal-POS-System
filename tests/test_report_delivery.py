"""WhatsApp executive-report recipients and delivery."""

from __future__ import annotations

from app.extensions import db
from app.models import Company, ReportDispatch, ReportRecipient
from app.services import whatsapp
from app.services.daily_reports import dispatch_company, dispatch_due
from app.services.executive import build_executive_summary
from app.services.timezones import zone_for
from tests.conftest import csrf
from tests.test_api import bootstrap, checkout, create_product


def add_recipient(client, headers, number="+263 77 123 4567", name="Tariro Moyo"):
    response = client.post(
        "/api/company/report-recipients",
        json={"name": name, "whatsapp_number": number, "role_label": "Owner"},
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["item"]


def test_whatsapp_number_normalisation():
    assert whatsapp.normalise_number("+263 77 123 4567") == "+263771234567"
    assert whatsapp.normalise_number("00263771234567") == "+263771234567"
    assert whatsapp.normalise_number("0771 234 567") == "+263771234567"
    assert whatsapp.mask_number("+263771234567").endswith("567")


def test_signup_captures_whatsapp_and_creates_recipient(client):
    response = client.post(
        "/api/auth/register",
        json={
            "company_name": "WhatsApp Bakery",
            "full_name": "New Owner",
            "email": "wa@signup.test",
            "password": "Password!123",
            "currency_code": "USD",
            "currency_symbol": "$",
            "whatsapp_number": "+263 77 555 0101",
        },
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert response.status_code == 201, response.get_json()
    payload = response.get_json()
    assert payload["company"]["settings"]["business"]["whatsapp_number"] == "+263775550101"

    headers = {"X-CSRF-Token": payload["csrf_token"]}
    recipients = client.get("/api/company/report-recipients", headers=headers).get_json()["items"]
    assert [row["name"] for row in recipients] == ["New Owner"]
    assert recipients[0]["role_label"] == "Workspace owner"


def test_report_recipients_crud_and_duplicate_block(client, owner):
    headers = owner["headers"]
    created = add_recipient(client, headers)
    assert created["whatsapp_number"] == "+263771234567"

    duplicate = client.post(
        "/api/company/report-recipients",
        json={"name": "Another name", "whatsapp_number": "0771234567"},
        headers=headers,
    )
    assert duplicate.status_code == 422
    assert duplicate.get_json()["error"]["fields"]

    updated = client.patch(
        f"/api/company/report-recipients/{created['id']}",
        json={"is_active": False, "role_label": "Accountant"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.get_json()["item"]["is_active"] is False

    listed = client.get("/api/company/report-recipients", headers=headers).get_json()
    assert len(listed["items"]) == 1
    assert listed["whatsapp"]["configured"] is False

    deleted = client.delete(f"/api/company/report-recipients/{created['id']}", headers=headers)
    assert deleted.status_code == 200
    assert client.get("/api/company/report-recipients", headers=headers).get_json()["items"] == []


def test_business_whatsapp_setting_is_normalised(client, owner):
    headers = owner["headers"]
    response = client.patch(
        "/api/company/settings",
        json={"business": {"whatsapp_number": "0771 234 567"}},
        headers=headers,
    )
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["settings"]["business"]["whatsapp_number"] == "+263771234567"


def test_executive_summary_contains_periods_and_advice(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers, name="Espresso", price_cents=12000, stock=20)
    method = bootstrap(client)["payment_methods"][0]
    sold = checkout(client, headers, product_id, method["id"], 12000)
    assert sold.status_code == 201, sold.get_json()

    report = build_executive_summary(db.session.get(Company, owner["company"]["id"]))
    text = report["text"]
    assert "TODAY" in text
    assert "THIS WEEK" in text
    assert "THIS MONTH" in text
    assert "THIS YEAR" in text
    assert "MANAGEMENT ADVICE" in text
    assert "Espresso" in text
    assert "BY TEAM MEMBER" in text
    assert "Tariro Moyo" in text or "Test Owner" in text
    assert report["metrics"]["today"]["sales_cents"] > 0
    assert report["team"] and report["team"][0]["sales_cents"] > 0
    assert report["advice"]


def test_dispatch_is_dry_run_and_idempotent(app, client, owner):
    headers = owner["headers"]
    add_recipient(client, headers)
    app.config["WHATSAPP_DRY_RUN"] = True
    company = db.session.get(Company, owner["company"]["id"])

    first = dispatch_company(company, force=True)
    assert first["status"] == "dry_run"
    assert first["delivered"] == 1
    assert first["failed"] == 0
    assert "TODAY" in first["text"]

    second = dispatch_company(company, force=False)
    assert second["status"] == "dry_run"
    assert second["delivered"] == 1

    dispatches = ReportDispatch.query.filter_by(company_id=company.id).all()
    assert len(dispatches) == 1
    assert dispatches[0].status == "dry_run"
    assert dispatches[0].delivered_count == 1


def test_dispatch_due_only_runs_after_six(client, owner, app):
    from datetime import datetime, timezone

    headers = owner["headers"]
    add_recipient(client, headers)
    company = db.session.get(Company, owner["company"]["id"])
    app.config["WHATSAPP_DRY_RUN"] = True
    local = datetime.now(zone_for(company)).replace(hour=17, minute=59)

    early = dispatch_due(now=local.astimezone(timezone.utc), dry_run=True)
    assert early == []

    local = local.replace(hour=18, minute=5)
    due = dispatch_due(now=local.astimezone(timezone.utc), dry_run=True)
    assert due and due[0]["status"] == "dry_run"


def test_send_now_endpoint_reports_connection_state(client, owner, app):
    headers = owner["headers"]
    add_recipient(client, headers)
    app.config["WHATSAPP_DRY_RUN"] = True
    response = client.post(
        "/api/company/report-recipients/send-now",
        json={"force": True},
        headers=headers,
    )
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["status"] == "dry_run"


def test_test_message_reports_missing_configuration(client, owner, app):
    headers = owner["headers"]
    recipient = add_recipient(client, headers)
    app.config["WHATSAPP_DRY_RUN"] = False
    app.config["WHATSAPP_PHONE_NUMBER_ID"] = ""
    app.config["WHATSAPP_ACCESS_TOKEN"] = ""
    response = client.post(
        f"/api/company/report-recipients/{recipient['id']}/test",
        json={},
        headers=headers,
    )
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "whatsapp_error"


def test_recipient_table_is_created(app):
    assert ReportRecipient.query.count() == 0
    assert ReportDispatch.query.count() == 0
