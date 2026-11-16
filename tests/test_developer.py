"""Developer console and custom workspaces."""

from __future__ import annotations

from app.extensions import db
from app.models import Company, Product, User
from tests.conftest import csrf, login


def test_developer_overview_and_company_lifecycle(client, developer, developer_headers, app):
    overview = client.get("/api/developer/overview", headers=developer_headers)
    assert overview.status_code == 200
    assert "stats" in overview.get_json()

    created = client.post(
        "/api/developer/companies",
        json={
            "name": "Provisioned Ltd",
            "plan": "growth",
            "status": "active",
            "currency_code": "EUR",
            "currency_symbol": "€",
            "owner_name": "Provisioned Owner",
            "owner_email": "owner@provisioned.test",
            "owner_password": "Password!1",
        },
        headers=developer_headers,
    )
    assert created.status_code == 201, created.get_json()
    company_id = created.get_json()["item"]["id"]

    with app.app_context():
        assert db.session.get(Company, company_id).slug == "provisioned-ltd"
        owner = User.query.filter_by(email="owner@provisioned.test").first()
        assert owner is not None and owner.role.name == "Owner"

    # The provisioned owner can sign in and sell.
    owner_headers = login(client, "owner@provisioned.test", "Password!1")
    assert client.get("/api/products", headers=owner_headers).status_code == 200

    # Back to the platform account to administer the tenant.
    client.post("/api/auth/logout", headers=owner_headers)
    developer_headers = login(client, developer["email"], developer["password"])

    suspended = client.patch(
        f"/api/developer/companies/{company_id}",
        json={"status": "suspended", "suspended_reason": "Non-payment"},
        headers=developer_headers,
    )
    assert suspended.status_code == 200

    retry = client.post(
        "/api/auth/login",
        json={"email": "owner@provisioned.test", "password": "Password!1"},
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert retry.status_code == 423

    developer_headers = login(client, developer["email"], developer["password"])
    deleted = client.delete(f"/api/developer/companies/{company_id}", headers=developer_headers)
    assert deleted.status_code == 200
    with app.app_context():
        assert db.session.get(Company, company_id) is None
        assert User.query.filter_by(email="owner@provisioned.test").first() is None


def test_developer_can_reset_a_user_password(client, developer_headers, owner):
    users = client.get("/api/developer/users", headers=developer_headers).get_json()["items"]
    target = next(user for user in users if user["email"] == owner["company"]["email"])

    response = client.patch(
        f"/api/developer/users/{target['id']}",
        json={"password": "BrandNew!123"},
        headers=developer_headers,
    )
    assert response.status_code == 200
    login(client, owner["company"]["email"], "BrandNew!123")


def test_developer_enters_a_workspace(client, developer_headers, owner):
    response = client.post(f"/api/auth/enter-company/{owner['company']['id']}", headers=developer_headers)
    assert response.status_code == 200
    session = response.get_json()
    assert session["impersonating"] is True
    assert session["company"]["name"] == "Test Company"
    assert client.get("/api/products", headers=developer_headers).status_code == 200

    leave = client.post("/api/auth/leave-company", headers=developer_headers)
    assert leave.status_code == 200
    assert leave.get_json()["company"] is None


def test_company_admin_routes_are_forbidden_to_developers(client, developer_headers):
    response = client.get("/api/company/settings", headers=developer_headers)
    assert response.status_code == 409


def test_platform_audit_records_company_activity(client, developer, developer_headers, owner):
    headers = owner["headers"]
    client.post("/api/categories", json={"name": "Audited"}, headers=headers)

    developer_headers = login(client, developer["email"], developer["password"])
    audit = client.get("/api/developer/audit", headers=developer_headers)
    assert audit.status_code == 200
    actions = {row["action"] for row in audit.get_json()["items"]}
    assert "category.created" in actions


# --------------------------------------------------------------------------- #
# Custom workspaces
# --------------------------------------------------------------------------- #
def test_custom_workspace_and_records(client, owner):
    headers = owner["headers"]
    created = client.post(
        "/api/workspaces",
        json={
            "name": "Repairs",
            "icon": "wrench",
            "description": "Track device repairs",
            "fields": [
                {"label": "Device", "type": "text", "required": True},
                {"label": "Status", "type": "select", "options": ["Intake", "Ready"]},
            ],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.get_json()
    workspace = created.get_json()["item"]
    assert [field["key"] for field in workspace["fields"]] == ["device", "status"]

    missing = client.post(f"/api/workspaces/{workspace['id']}/records", json={"data": {}}, headers=headers)
    assert missing.status_code == 422

    record = client.post(
        f"/api/workspaces/{workspace['id']}/records",
        json={"data": {"device": "iPhone 13", "status": "Intake"}},
        headers=headers,
    )
    assert record.status_code == 201, record.get_json()

    listing = client.get(f"/api/workspaces/{workspace['id']}/records", headers=headers).get_json()
    assert listing["meta"]["total"] == 1
    assert listing["items"][0]["data"]["device"] == "iPhone 13"

    csv_response = client.get(f"/api/workspaces/{workspace['id']}/records.csv", headers=headers)
    assert csv_response.status_code == 200
    assert "Device" in csv_response.data.decode("utf-8")


def test_workspace_requires_module(client, owner):
    headers = owner["headers"]
    client.patch("/api/company/modules/custom_workspaces", json={"enabled": False}, headers=headers)
    response = client.get("/api/workspaces", headers=headers)
    assert response.status_code == 422
