"""API behaviour: auth, RBAC, checkout, refunds, stock and settings."""

from __future__ import annotations

from datetime import date, timedelta

from app.extensions import db
from app.models import Product, Sale, StockMovement, User
from tests.conftest import csrf, login


def create_product(client, headers, name="Latte", price_cents=1000, stock=50) -> int:
    response = client.post(
        "/api/products",
        json={
            "name": name,
            "price": f"{price_cents / 100:.2f}",
            "cost": "4.00",
            "stock_qty": stock,
            "track_stock": True,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["item"]["id"]


def bootstrap(client):
    response = client.get("/api/pos/bootstrap")
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def checkout(client, headers, product_id, method_id, amount_cents, qty=1):
    return client.post(
        "/api/sales",
        json={
            "lines": [{"product_id": product_id, "qty": qty}],
            "payments": [{"method_id": method_id, "amount_cents": amount_cents, "tendered_cents": amount_cents}],
        },
        headers=headers,
    )


# --------------------------------------------------------------------------- #
# Auth & tenancy
# --------------------------------------------------------------------------- #
def test_session_requires_csrf_for_writes(client, owner):
    response = client.post("/api/categories", json={"name": "No token"})
    assert response.status_code == 419
    assert response.get_json()["error"]["code"] == "csrf_failed"


def test_login_rejects_bad_credentials(client, owner):
    response = client.post(
        "/api/auth/login",
        json={"email": owner["company"]["email"], "password": "wrong-password"},
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert response.status_code == 401


def test_self_service_signup_creates_workspace(client):
    response = client.post(
        "/api/auth/register",
        json={
            "company_name": "Signup Bakery",
            "full_name": "New Owner",
            "email": "new@signup.test",
            "password": "Password!123",
            "currency_code": "GBP",
            "currency_symbol": "£",
        },
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert response.status_code == 201, response.get_json()
    payload = response.get_json()
    assert payload["company"]["slug"] == "signup-bakery"
    assert payload["company"]["settings"]["currency"]["code"] == "GBP"
    assert payload["user"]["role"] == "Administrator"
    assert payload["modules"]["pos"]["enabled"] is True

    # Sign-in email stays private unless the owner says it is the company email.
    settings = payload["company"]["settings"]
    assert payload["company"]["contact_email"] == ""
    assert settings["business"]["email"] == ""

    # Every new workspace starts with Zimbabwe's VAT 15.5% already set up as the
    # default rate (assigned to products, not force-applied to untaxed ones).
    headers = {"X-CSRF-Token": payload["csrf_token"]}
    taxes = client.get("/api/company/taxes", headers=headers).get_json()["items"]
    assert [(row["name"], row["rate"], row["is_default"]) for row in taxes] == [("VAT 15.5%", 15.5, True)]


def test_signup_can_reuse_the_login_email_as_the_company_email(client):
    response = client.post(
        "/api/auth/register",
        json={
            "company_name": "Shared Mail Traders",
            "full_name": "Same Mail",
            "email": "shop@signup.test",
            "password": "Password!123",
            "email_is_company_email": True,
        },
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert response.status_code == 201, response.get_json()
    company = response.get_json()["company"]
    assert company["contact_email"] == "shop@signup.test"
    assert company["settings"]["business"]["email"] == "shop@signup.test"


def test_developer_cannot_use_tenant_endpoints(client, developer_headers):
    response = client.get("/api/products", headers=developer_headers)
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "no_company"


def test_restricted_role_cannot_manage_catalog(client, owner):
    headers = owner["headers"]
    roles = client.get("/api/company/roles", headers=headers).get_json()["items"]
    cashier_role = next(role for role in roles if role["name"] == "Cashier")

    created = client.post(
        "/api/company/users",
        json={
            "full_name": "Till User",
            "email": "till@test.dev",
            "password": "Password!1",
            "role_id": cashier_role["id"],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.get_json()

    cashier_headers = login(client, "till@test.dev", "Password!1")
    # Everyone invited with a temporary password replaces it before they can work.
    changed = client.post("/api/auth/password", json={"new_password": "TillOwn!9"}, headers=cashier_headers)
    assert changed.status_code == 200, changed.get_json()
    forbidden = client.post(
        "/api/products",
        json={"name": "Should fail", "price": "1.00"},
        headers=cashier_headers,
    )
    assert forbidden.status_code == 403
    assert client.get("/api/products", headers=cashier_headers).status_code == 200
    assert client.get("/api/company/settings", headers=cashier_headers).status_code == 403


# --------------------------------------------------------------------------- #
# Selling
# --------------------------------------------------------------------------- #
def test_checkout_then_partial_refund_restores_stock(client, owner, app):
    headers = owner["headers"]
    product_id = create_product(client, headers, stock=10)
    method = bootstrap(client)["payment_methods"][0]

    response = checkout(client, headers, product_id, method["id"], 2000, qty=2)
    assert response.status_code == 201, response.get_json()
    sale = response.get_json()["item"]
    assert sale["total_cents"] == 2000
    assert sale["status"] == "completed"

    with app.app_context():
        assert db.session.get(Product, product_id).stock_qty == 8

    refund = client.post(
        f"/api/sales/{sale['id']}/refund",
        json={"items": [{"sale_item_id": sale["items"][0]["id"], "qty": 1}], "reason": "One broken", "restock": True},
        headers=headers,
    )
    assert refund.status_code == 200, refund.get_json()
    assert refund.get_json()["sale"]["status"] == "partially_refunded"

    with app.app_context():
        assert db.session.get(Product, product_id).stock_qty == 9


def test_payment_shortfall_is_rejected(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    response = checkout(client, headers, product_id, method["id"], 500)
    assert response.status_code == 422
    assert "short" in response.get_json()["error"]["message"].lower()


def test_void_returns_stock_and_marks_sale(client, owner, app):
    headers = owner["headers"]
    product_id = create_product(client, headers, stock=5)
    method = bootstrap(client)["payment_methods"][0]
    sale = checkout(client, headers, product_id, method["id"], 1000).get_json()["item"]

    voided = client.post(f"/api/sales/{sale['id']}/void", json={"reason": "Mistake"}, headers=headers)
    assert voided.status_code == 200
    assert voided.get_json()["item"]["status"] == "voided"
    with app.app_context():
        assert db.session.get(Product, product_id).stock_qty == 5


def test_stock_adjustment_records_a_movement(client, owner, app):
    headers = owner["headers"]
    product_id = create_product(client, headers, stock=4)
    response = client.post(
        f"/api/products/{product_id}/stock",
        json={"mode": "delta", "qty": 6, "reason": "receive", "note": "Delivery", "buying_price": "4.50"},
        headers=headers,
    )
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["item"]["stock_qty"] == 10
    with app.app_context():
        movement = StockMovement.query.filter_by(product_id=product_id, reason="receive").first()
        assert movement is not None and movement.qty_delta == 6


def test_receipt_contains_barcode_and_number(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    sale = checkout(client, headers, product_id, method["id"], 1000).get_json()["item"]

    receipt = client.get(f"/api/sales/{sale['id']}/receipt")
    assert receipt.status_code == 200
    body = receipt.data.decode("utf-8")
    assert sale["number"] in body
    assert "<svg" in body and "barcode" in body


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def test_settings_merge_and_validate_colours(client, owner):
    headers = owner["headers"]
    response = client.patch(
        "/api/company/settings",
        json={"branding": {"primary": "#123456", "theme": "dark", "radius": 20}},
        headers=headers,
    )
    assert response.status_code == 200
    branding = response.get_json()["settings"]["branding"]
    assert branding["primary"] == "#123456"
    assert branding["theme"] == "dark"

    bad = client.patch(
        "/api/company/settings",
        json={"branding": {"primary": "not-a-colour"}},
        headers=headers,
    )
    assert bad.status_code == 422


def test_module_config_is_schema_validated(client, owner):
    headers = owner["headers"]
    ok = client.patch(
        "/api/company/modules/pos",
        json={"enabled": True, "config": {"grid_columns": 5, "show_stock": False}},
        headers=headers,
    )
    assert ok.status_code == 200
    assert ok.get_json()["module"]["config"]["grid_columns"] == 5

    too_many = client.patch(
        "/api/company/modules/pos",
        json={"config": {"grid_columns": 99}},
        headers=headers,
    )
    assert too_many.status_code == 422

    unknown_key = client.patch(
        "/api/company/modules/pos",
        json={"enabled": False},
        headers=headers,
    )
    assert unknown_key.status_code == 422  # core module cannot be disabled


def test_tax_rate_crud_and_default_switch(client, owner):
    headers = owner["headers"]
    first = client.post("/api/company/taxes", json={"name": "VAT 15", "rate": 15, "is_default": True}, headers=headers)
    second = client.post("/api/company/taxes", json={"name": "VAT 20", "rate": 20, "is_default": True}, headers=headers)
    assert first.status_code == 201 and second.status_code == 201

    taxes = client.get("/api/company/taxes", headers=headers).get_json()["items"]
    defaults = [tax for tax in taxes if tax["is_default"]]
    assert len(defaults) == 1 and defaults[0]["name"] == "VAT 20"


def test_custom_field_values_are_validated(client, owner):
    headers = owner["headers"]
    field = client.post(
        "/api/company/custom-fields",
        json={"entity": "product", "label": "Allergens", "type": "select", "options": ["Nuts", "Dairy"]},
        headers=headers,
    )
    assert field.status_code == 201, field.get_json()

    invalid = client.post(
        "/api/products",
        json={"name": "Bad field", "price": "1.00", "custom_fields": {"allergens": "Gluten"}},
        headers=headers,
    )
    assert invalid.status_code == 422

    valid = client.post(
        "/api/products",
        json={"name": "Good field", "price": "1.00", "custom_fields": {"allergens": "Nuts"}},
        headers=headers,
    )
    assert valid.status_code == 201


def test_cannot_delete_the_last_owner(client, owner, app):
    headers = owner["headers"]
    with app.app_context():
        me = User.query.filter_by(email=owner["company"]["email"]).first()
        my_id = me.id
    response = client.delete(f"/api/company/users/{my_id}", headers=headers)
    assert response.status_code == 422


def test_loyalty_points_earn_on_sale(client, owner, app):
    headers = owner["headers"]
    client.patch(
        "/api/company/modules/loyalty",
        json={"enabled": True, "config": {"points_per_100": 2, "redeem_value": 1}},
        headers=headers,
    )
    customer = client.post("/api/customers", json={"name": "Loyal Patron"}, headers=headers).get_json()["item"]
    product_id = create_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]

    response = client.post(
        "/api/sales",
        json={
            "lines": [{"product_id": product_id, "qty": 1}],
            "payments": [{"method_id": method["id"], "amount_cents": 1000}],
            "customer_id": customer["id"],
        },
        headers=headers,
    )
    assert response.status_code == 201
    detail = client.get(f"/api/customers/{customer['id']}", headers=headers).get_json()["item"]
    assert detail["loyalty_points"] == 20
    assert detail["total_spent_cents"] == 1000


def test_reports_round_trip_and_csv(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product_id, method["id"], 1000)

    today = date.today()
    params = {"from": (today - timedelta(days=1)).isoformat(), "to": (today + timedelta(days=1)).isoformat()}
    overview = client.get("/api/reports/overview", query_string=params, headers=headers)
    assert overview.status_code == 200
    assert overview.get_json()["cards"]["transactions"] == 1

    csv_response = client.get("/api/reports/sales.csv", query_string=params, headers=headers)
    assert csv_response.status_code == 200
    assert csv_response.mimetype == "text/csv"
    assert "Total" in csv_response.data.decode("utf-8").splitlines()[0]


# --------------------------------------------------------------------------- #
# Personal preferences & toggle effects
# --------------------------------------------------------------------------- #
def test_preferences_are_saved_per_user(client, owner):
    headers = owner["headers"]
    saved = client.patch(
        "/api/auth/preferences",
        json={
            "theme": "dark",
            "density": "compact",
            "sidebar": "expanded",
            "dashboard_widgets": ["sales_today", "bogus_widget"],
            "pos": {"sound_enabled": False},
        },
        headers=headers,
    )
    assert saved.status_code == 200, saved.get_json()
    prefs = saved.get_json()["preferences"]
    assert prefs["theme"] == "dark"
    assert prefs["dashboard_widgets"] == ["sales_today"]
    assert prefs["pos"]["sound_enabled"] is False
    # Untouched keys keep their inherit-from-workspace default.
    assert prefs["pos"]["auto_print"] is None

    session = client.get("/api/auth/session").get_json()
    assert session["preferences"]["theme"] == "dark"

    roles = client.get("/api/company/roles", headers=headers).get_json()["items"]
    cashier_role = next(role for role in roles if role["name"] == "Cashier")
    client.post(
        "/api/company/users",
        json={"full_name": "Till User", "email": "till@test.dev", "password": "Password!1",
              "role_id": cashier_role["id"]},
        headers=headers,
    )
    cashier_headers = login(client, "till@test.dev", "Password!1")
    cashier_session = client.get("/api/auth/session", headers=cashier_headers).get_json()
    assert cashier_session["preferences"]["theme"] == ""
    assert cashier_session["preferences"]["dashboard_widgets"] is None


def test_preferences_reject_unknown_values(client, owner):
    headers = owner["headers"]
    bad_theme = client.patch("/api/auth/preferences", json={"theme": "neon"}, headers=headers)
    assert bad_theme.status_code == 422
    bad_pos = client.patch("/api/auth/preferences", json={"pos": {"sound_enabled": "loud"}}, headers=headers)
    assert bad_pos.status_code == 422


def test_price_override_switch_limits_the_till(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers, price_cents=1000)
    method = bootstrap(client)["payment_methods"][0]

    def sell(unit_price_cents, pin=""):
        return client.post(
            "/api/sales",
            json={
                "lines": [{"product_id": product_id, "qty": 1, "unit_price_cents": unit_price_cents,
                           "override_pin": pin}],
                "payments": [{"method_id": method["id"], "amount_cents": unit_price_cents}],
            },
            headers=headers,
        )

    # Module off: a cheaper line price is refused outright.
    assert sell(800).status_code == 422

    client.patch(
        "/api/company/modules/price_overrides",
        json={"enabled": True, "config": {"max_percent_below": 20, "require_pin": False}},
        headers=headers,
    )
    within_limit = sell(850)
    assert within_limit.status_code == 201, within_limit.get_json()
    assert within_limit.get_json()["item"]["items"][0]["unit_price_cents"] == 850

    too_cheap = sell(500)
    assert too_cheap.status_code == 422

    # Requiring a PIN blocks anonymous overrides but accepts a supervisor PIN.
    client.patch(
        "/api/company/modules/price_overrides",
        json={"config": {"require_pin": True}},
        headers=headers,
    )
    assert sell(900).status_code == 422
    owner_id = client.get("/api/auth/session").get_json()["user"]["id"]
    client.patch(f"/api/company/users/{owner_id}", json={"pin": "2468"}, headers=headers)
    assert sell(900, pin="2468").status_code == 201


def test_tax_engine_and_store_credit_switches(client, owner):
    headers = owner["headers"]
    tax = client.post(
        "/api/company/taxes", json={"name": "VAT 15", "rate": 15, "is_default": True}, headers=headers
    ).get_json()["item"]
    client.patch(
        "/api/company/settings", json={"sales": {"default_tax_rate_id": tax["id"]}}, headers=headers
    )
    product_id = create_product(client, headers, price_cents=1000)
    method = bootstrap(client)["payment_methods"][0]

    with_tax = checkout(client, headers, product_id, method["id"], 1150)
    assert with_tax.status_code == 201, with_tax.get_json()
    assert with_tax.get_json()["item"]["tax_cents"] == 150

    client.patch("/api/company/modules/tax_engine", json={"enabled": False}, headers=headers)
    without_tax = checkout(client, headers, product_id, method["id"], 1000)
    assert without_tax.status_code == 201, without_tax.get_json()
    assert without_tax.get_json()["item"]["tax_cents"] == 0


def test_manual_discount_switches_apply_to_line_discounts(client, owner):
    headers = owner["headers"]
    product_id = create_product(client, headers, price_cents=1000)
    method = bootstrap(client)["payment_methods"][0]

    def sell(discount_cents):
        return client.post(
            "/api/sales",
            json={
                "lines": [{"product_id": product_id, "qty": 1, "discount_cents": discount_cents}],
                "payments": [{"method_id": method["id"], "amount_cents": 1000 - discount_cents}],
            },
            headers=headers,
        )

    client.patch(
        "/api/company/modules/discounts",
        json={"enabled": True, "config": {"allow_manual": True, "max_manual_percent": 10}},
        headers=headers,
    )
    assert sell(100).status_code == 201
    assert sell(500).status_code == 422

    client.patch("/api/company/modules/discounts", json={"config": {"allow_manual": False}}, headers=headers)
    assert sell(50).status_code == 422


def test_shift_close_respects_the_count_switch(client, owner):
    headers = owner["headers"]
    shift = client.post("/api/shifts/open", json={"opening_float": "10.00"}, headers=headers).get_json()["item"]

    missing = client.post(f"/api/shifts/{shift['id']}/close", json={}, headers=headers)
    assert missing.status_code == 422

    counted = client.post(f"/api/shifts/{shift['id']}/close", json={"counted_cash": 10}, headers=headers)
    assert counted.status_code == 200, counted.get_json()

    client.patch("/api/company/modules/shifts", json={"config": {"count_payments": False}}, headers=headers)
    second = client.post("/api/shifts/open", json={"opening_float": "0.00"}, headers=headers).get_json()["item"]
    without_count = client.post(f"/api/shifts/{second['id']}/close", json={}, headers=headers)
    assert without_count.status_code == 200, without_count.get_json()

