"""Feature coverage: duplicates, branches, lay-by, bulk stock, insights and roles."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from app.services.timezones import local_day_bounds, local_today, to_local
from tests.conftest import csrf, login
from tests.test_api import bootstrap, checkout, create_product


def make_product(client, headers, **overrides) -> dict:
    payload = {
        "name": "Cordless Drill",
        "price": "120.00",
        "cost": "80.00",
        "sku": "DRL-001",
        "barcode": "200000001",
        "stock_qty": 5,
        "track_stock": True,
    }
    payload.update(overrides)
    response = client.post("/api/products", json=payload, headers=headers)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["item"]


def test_duplicate_sku_and_barcode_are_blocked(client, owner):
    headers = owner["headers"]
    make_product(client, headers)

    same_sku = client.post(
        "/api/products",
        json={"name": "Other drill", "price": "50.00", "sku": "drl-001"},
        headers=headers,
    )
    assert same_sku.status_code == 422
    assert "SKU" in same_sku.get_json()["error"]["message"]

    same_barcode = client.post(
        "/api/products",
        json={"name": "Other drill", "price": "50.00", "barcode": "200000001"},
        headers=headers,
    )
    assert same_barcode.status_code == 422
    assert "barcode" in same_barcode.get_json()["error"]["message"].lower()


def test_receive_stock_updates_prices_and_logs_movement(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, stock_qty=5)

    response = client.post(
        f"/api/products/{product['id']}/stock",
        json={
            "mode": "delta",
            "qty": 4,
            "reason": "receive",
            "note": "Invoice INV-77",
            "reference": "INV-77",
            "buying_price": "85.00",
            "selling_price": "129.99",
        },
        headers=headers,
    )
    assert response.status_code == 200, response.get_json()
    updated = response.get_json()["item"]
    assert updated["stock_qty"] == 9
    assert updated["cost_cents"] == 8500
    assert updated["price_cents"] == 12999
    assert response.get_json()["movement"]["note"] == "Invoice INV-77"

    movements = client.get(
        f"/api/stock-movements?product_id={product['id']}", headers=headers
    ).get_json()["items"]
    assert any(row["reason"] == "receive" and row["qty_delta"] == 4 for row in movements)


def test_admin_can_remove_staff_but_not_another_admin(client, owner):
    headers = owner["headers"]
    roles = client.get("/api/company/users", headers=headers).get_json()["roles"]
    by_name = {role["name"]: role["id"] for role in roles}

    cashier = client.post(
        "/api/company/users",
        json={
            "full_name": "Till Operator",
            "email": "till@test.dev",
            "password": "Password!1",
            "role_id": by_name["Cashier"],
        },
        headers=headers,
    )
    assert cashier.status_code == 201, cashier.get_json()

    peer = client.post(
        "/api/company/users",
        json={
            "full_name": "Second Admin",
            "email": "second@test.dev",
            "password": "Password!1",
            "role_id": by_name["Administrator"],
        },
        headers=headers,
    )
    assert peer.status_code == 201, peer.get_json()
    peer_id = peer.get_json()["item"]["id"]

    removed = client.delete(f"/api/company/users/{cashier.get_json()['item']['id']}", headers=headers)
    assert removed.status_code == 200

    blocked = client.delete(f"/api/company/users/{peer_id}", headers=headers)
    assert blocked.status_code == 422
    assert "ordinary staff" in blocked.get_json()["error"]["message"]


def test_branches_feed_checkout_and_reports(client, owner):
    headers = owner["headers"]
    branch = client.post(
        "/api/company/locations",
        json={"name": "Borrowdale", "code": "BRW"},
        headers=headers,
    )
    assert branch.status_code == 201, branch.get_json()
    branch_id = branch.get_json()["item"]["id"]

    till = client.post(
        "/api/company/registers",
        json={"location_id": branch_id, "name": "Till 2", "code": "T2"},
        headers=headers,
    )
    assert till.status_code == 201, till.get_json()
    till_id = till.get_json()["item"]["id"]

    renamed = client.patch(
        f"/api/company/registers/{till_id}",
        json={"name": "Till 2 (Express)", "is_active": False},
        headers=headers,
    )
    assert renamed.status_code == 200, renamed.get_json()
    assert renamed.get_json()["item"]["name"] == "Till 2 (Express)"

    product = make_product(client, headers, stock_qty=10)
    method = bootstrap(client)["payment_methods"][0]
    sale = client.post(
        "/api/sales",
        json={
            "lines": [{"product_id": product["id"], "qty": 1}],
            "payments": [{"method_id": method["id"], "amount_cents": 12000, "tendered_cents": 12000}],
            "location_id": branch_id,
            "register_id": till_id,
        },
        headers=headers,
    )
    assert sale.status_code == 201, sale.get_json()

    filtered = client.get(
        f"/api/reports/overview?location_id={branch_id}", headers=headers
    ).get_json()
    assert filtered["cards"]["transactions"] == 1
    assert filtered["branches"][0]["name"] == "Borrowdale"

    report = client.get("/api/reports/branches", headers=headers)
    assert report.status_code == 200
    assert "Borrowdale" in json.dumps(report.get_json())


def test_layby_reserves_stock_and_settles_into_a_sale(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, stock_qty=2)
    customer = client.post(
        "/api/customers", json={"name": "Tendai Moyo", "phone": "0772000111"}, headers=headers
    ).get_json()["item"]
    method = bootstrap(client)["payment_methods"][0]

    created = client.post(
        "/api/laybys",
        json={
            "customer_id": customer["id"],
            "lines": [{"product_id": product["id"], "qty": 1}],
            "deposit_amount": "30.00",
            "payment_method_id": method["id"],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.get_json()
    layby = created.get_json()["item"]
    assert layby["status"] == "active"
    assert layby["balance_cents"] == 9000

    after_reserve = client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]
    assert after_reserve["stock_qty"] == 1

    settled = client.post(
        f"/api/laybys/{layby['id']}/payments",
        json={"amount": "90.00", "payment_method_id": method["id"]},
        headers=headers,
    )
    assert settled.status_code == 200, settled.get_json()
    assert settled.get_json()["item"]["status"] == "completed"

    sale_lookup = client.get(
        f"/api/sales?q={customer['name']}", headers=headers
    ).get_json()["items"]
    assert any(row["source"] == "layby" for row in sale_lookup)


def test_layby_cancellation_returns_stock(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, stock_qty=3)
    customer = client.post("/api/customers", json={"name": "Rudo Ncube"}, headers=headers).get_json()["item"]

    layby = client.post(
        "/api/laybys",
        json={
            "customer_id": customer["id"],
            "lines": [{"product_id": product["id"], "qty": 2}],
            "deposit_amount": "50.00",
        },
        headers=headers,
    ).get_json()["item"]
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 1

    cancelled = client.post(f"/api/laybys/{layby['id']}/cancel", json={"reason": "Customer changed mind"}, headers=headers)
    assert cancelled.status_code == 200, cancelled.get_json()
    assert cancelled.get_json()["restocked"] is True
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 3


def test_bulk_import_accepts_template_headers_and_count_applies_variances(client, owner):
    headers = owner["headers"]
    csv_text = (
        "SKU,Barcode,Name,Department,Category,Unit,Buying Price,Selling Price,"
        "OpeningStock,LowStockAt,TaxRate,Active\n"
        'SKU-9001,200009001,Cordless Drill 18V,Hardware,Power Tools,unit,65.00,110.00,12,3,15,yes\n'
    )
    imported = client.post("/api/inventory/import", json={"csv": csv_text}, headers=headers)
    assert imported.status_code == 200, imported.get_json()
    assert imported.get_json()["created"] == 1

    products = client.get("/api/products?q=Cordless", headers=headers).get_json()["items"]
    drill = products[0]
    assert drill["cost_cents"] == 6500
    assert drill["price_cents"] == 11000
    assert drill["stock_qty"] == 12
    assert drill["low_stock_threshold"] == 3
    assert drill["department"] == "Hardware"

    count_csv = "SKU,Name,SystemQty,CountedQty\nSKU-9001,Cordless Drill 18V,12,10\n"
    preview = client.post("/api/inventory/count?apply=0", json={"csv": count_csv}, headers=headers)
    assert preview.status_code == 200, preview.get_json()
    assert preview.get_json()["mode"] == "preview"
    assert preview.get_json()["variances"][0]["variance"] == -2
    assert client.get(f"/api/products/{drill['id']}", headers=headers).get_json()["item"]["stock_qty"] == 12

    applied = client.post("/api/inventory/count?apply=1", json={"csv": count_csv}, headers=headers)
    assert applied.status_code == 200
    assert applied.get_json()["applied"] == 1
    assert client.get(f"/api/products/{drill['id']}", headers=headers).get_json()["item"]["stock_qty"] == 10


def test_insights_returns_management_snapshot(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product["id"], method["id"], 12000)

    response = client.get("/api/reports/insights", headers=headers)
    assert response.status_code == 200, response.get_json()
    payload = response.get_json()
    for key in ("revenue", "profit_leaders", "slow_movers", "restock", "tips", "layby"):
        assert key in payload
    assert payload["revenue"]["last_30_cents"] == 12000
    assert payload["local_today"] == local_today(None).isoformat()
    assert payload["profit_leaders"][0]["profit_cents"] == 4000


def test_receipt_lookup_and_void_restock(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, stock_qty=4)
    method = bootstrap(client)["payment_methods"][0]
    sale = checkout(client, headers, product["id"], method["id"], 12000).get_json()["item"]

    lookup = client.post("/api/sales/lookup-receipt", json={"number": sale["number"]}, headers=headers)
    assert lookup.status_code == 200, lookup.get_json()
    assert lookup.get_json()["item"]["id"] == sale["id"]

    voided = client.post(f"/api/sales/{sale['id']}/void", json={"reason": "Scanned twice"}, headers=headers)
    assert voided.status_code == 200, voided.get_json()
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 4


def test_timezone_helpers_use_harare(app):
    with app.app_context():
        start, end = local_day_bounds(None)
        assert (end - start) > timedelta(hours=23)
        assert to_local(start, None).hour == 0
        assert to_local(end, None).date() == to_local(start, None).date()
        # 12:00 UTC is 14:00 in Harare (CAT, UTC+2).
        assert to_local(datetime(2024, 1, 15, 12, 0), None).hour == 14
        assert to_local(datetime(2024, 1, 15, 22, 30), None).date() == datetime(2024, 1, 16).date()
