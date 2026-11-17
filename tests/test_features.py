"""Feature coverage: duplicates, branches, lay-by, bulk stock, insights and roles."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
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


def test_report_pdfs_are_valid_and_include_profit(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product["id"], method["id"], 12000)

    params = {"from": (date.today() - timedelta(days=1)).isoformat(),
              "to": (date.today() + timedelta(days=1)).isoformat()}

    summary = client.get("/api/reports/summary.pdf", query_string=params, headers=headers)
    assert summary.status_code == 200, summary.get_json()
    assert summary.mimetype == "application/pdf"
    assert summary.data.startswith(b"%PDF")
    assert len(summary.data) > 3000

    for key in ("sales", "products", "categories", "cashiers", "branches", "payments", "tax", "inventory",
                "low_stock"):
        response = client.get(f"/api/reports/{key}.pdf", query_string=params, headers=headers)
        assert response.status_code == 200, (key, response.get_json())
        assert response.data.startswith(b"%PDF"), key
        assert "attachment" in response.headers["Content-Disposition"]

    # Profit travels with the sales reports in CSV too.
    csv_text = client.get("/api/reports/products.csv", query_string=params, headers=headers).data.decode()
    assert "Profit" in csv_text and "Cost" in csv_text

    # The overview series exposes profit so charts can plot it.
    series = client.get("/api/reports/overview", query_string=params, headers=headers).get_json()["series"]
    assert all("profit_cents" in row and "cost_cents" in row for row in series)


def test_low_stock_report_and_mobile_snapshot(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, stock_qty=5, low_stock_threshold=5)
    make_product(client, headers, name="Plenty of nails", sku="NLS-001", barcode="200000002",
                 stock_qty=90, low_stock_threshold=5)

    report = client.get("/api/reports/low_stock", headers=headers)
    assert report.status_code == 200, report.get_json()
    payload = report.get_json()
    assert [column["key"] for column in payload["columns"]][-2:] == ["order_qty", "value"]
    assert [row[0] for row in payload["rows"]] == [product["name"]]
    assert payload["rows"][0][5] == 5  # brings the shelf back to twice its low point
    assert payload["rows"][0][6] == 5 * product["cost_cents"]

    # The report is gated on the inventory module, like the rest of the stock family.
    keys = {entry["key"] for entry in client.get("/api/reports/catalog", headers=headers).get_json()["reports"]}
    assert "low_stock" in keys

    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product["id"], method["id"], product["price_cents"])

    snapshot = client.get("/api/reports/mobile", headers=headers)
    assert snapshot.status_code == 200, snapshot.get_json()
    data = snapshot.get_json()
    cards = data["cards"]
    assert cards["sales_cents"] == product["price_cents"]
    assert cards["profit_cents"] == product["price_cents"] - product["cost_cents"]
    assert cards["transactions"] == 1
    assert data["stock"]["alerts"] == 1
    assert data["stock"]["items"][0]["name"] == product["name"]
    assert data["local_today"] == local_today(None).isoformat()
    assert [row["date"] for row in data["series"]][-1] == local_today(None).isoformat()
    assert data["departments"], "summary needs a department breakdown"
    assert data["branches"], "summary needs a branch breakdown"
    download_keys = [item["key"] for item in data["downloads"]]
    assert download_keys[:2] == ["summary", "sales"]
    assert "low_stock" in download_keys

    # The period is the caller's, not "today": asking for a past window returns nothing.
    past = client.get(
        "/api/reports/mobile",
        query_string={"from": "2020-01-01", "to": "2020-01-02"},
        headers=headers,
    ).get_json()
    assert past["cards"]["transactions"] == 0
    assert past["cards"]["sales_cents"] == 0


def test_stock_movement_and_shift_search(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, name="Cordless Drill", sku="DRL-777")
    client.post(
        f"/api/products/{product['id']}/stock",
        json={"mode": "delta", "qty": 3, "reason": "receive", "reference": "DN-42",
              "note": "Delivery note DN-42", "buying_price": "82.00"},
        headers=headers,
    )

    by_name = client.get("/api/stock-movements", query_string={"q": "Drill"}, headers=headers).get_json()
    assert by_name["items"], by_name
    assert all("Drill" in item["product"] for item in by_name["items"])
    by_reference = client.get("/api/stock-movements", query_string={"q": "DN-42"}, headers=headers).get_json()
    assert by_reference["items"], by_reference
    assert client.get("/api/stock-movements", query_string={"q": "nothing-here"}, headers=headers).get_json()["items"] == []

    opened = client.post("/api/shifts/open", json={"opening_float": "10.00"}, headers=headers)
    assert opened.status_code == 201, opened.get_json()
    shift = client.get("/api/shifts", query_string={"q": "Test Owner"}, headers=headers).get_json()
    assert shift["items"], shift
    assert client.get("/api/shifts", query_string={"q": "no-such-cashier"}, headers=headers).get_json()["items"] == []


def test_fifo_costing_uses_the_oldest_buying_prices(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, name="FIFO Widget", sku="FIFO-1", barcode="900000001",
                           stock_qty=0, price="20.00", cost="0.00")

    # Two deliveries at different buying prices.
    for qty, price, note in ((10, "5.00", "First delivery"), (10, "7.00", "Second delivery")):
        received = client.post(
            f"/api/products/{product['id']}/stock",
            json={"mode": "delta", "qty": qty, "reason": "receive", "note": note, "buying_price": price},
            headers=headers,
        )
        assert received.status_code == 200, received.get_json()

    method = bootstrap(client)["payment_methods"][0]
    sale = checkout(client, headers, product["id"], method["id"], 24000, qty=12).get_json()["item"]

    # 10 units at 5.00 + 2 units at 7.00 = 64.00 of goods, sold for 240.00.
    assert sale["cost_cents"] == 6400
    assert sale["total_cents"] == 24000
    assert sale["total_cents"] - sale["cost_cents"] == 17600

    stock = client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]
    assert stock["stock_qty"] == 8
    # The 8 left are the second layer, so FIFO value is 8 × 7.00.
    assert stock["stock_value_cents"] == 5600

    # Selling stock without a buying price is refused now that FIFO needs it.
    missing_price = client.post(
        f"/api/products/{product['id']}/stock",
        json={"mode": "delta", "qty": 2, "reason": "receive", "note": "No price"},
        headers=headers,
    )
    assert missing_price.status_code == 422
    assert "buying price" in missing_price.get_json()["error"]["message"].lower()


def test_layby_reduces_stock_and_prints_a_statement(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, name="Layby Sofa", sku="LAY-1", barcode="900000002", stock_qty=6)
    customer = client.post("/api/customers", json={"name": "Tendai Moyo", "phone": "0771234567"},
                           headers=headers).get_json()["item"]
    method = bootstrap(client)["payment_methods"][0]

    created = client.post("/api/laybys", json={
        "customer_id": customer["id"],
        "lines": [{"product_id": product["id"], "qty": 2}],
        "deposit_amount": "50.00",
        "payment_method_id": method["id"],
        "due_date": (date.today() + timedelta(days=30)).isoformat(),
    }, headers=headers)
    assert created.status_code == 201, created.get_json()
    layby = created.get_json()["item"]

    # Reserved goods leave the shelf immediately, exactly like a sale.
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 4

    statement = client.get(f"/api/laybys/{layby['id']}/statement", headers=headers)
    assert statement.status_code == 200
    assert b"Lay-by" in statement.data

    pdf = client.get(f"/api/laybys/{layby['id']}/statement.pdf", headers=headers)
    assert pdf.status_code == 200, pdf.get_json()
    assert pdf.mimetype == "application/pdf"
    assert pdf.data.startswith(b"%PDF")
    assert "attachment" in pdf.headers["Content-Disposition"]

    cancelled = client.post(f"/api/laybys/{layby['id']}/cancel",
                            json={"reason": "Changed mind", "restock": True}, headers=headers)
    assert cancelled.status_code == 200, cancelled.get_json()
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 6


def test_layby_completion_uses_fifo_cost_and_keeps_stock(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers, name="Layby TV", sku="LAY-2", barcode="900000003",
                           stock_qty=4, price="100.00", cost="40.00")
    # A second, dearer delivery so FIFO has two layers to draw from.
    client.post(f"/api/products/{product['id']}/stock",
                json={"mode": "delta", "qty": 4, "reason": "receive", "note": "Second batch",
                      "buying_price": "60.00"},
                headers=headers)
    customer = client.post("/api/customers", json={"name": "Rudo Ncube"}, headers=headers).get_json()["item"]
    method = bootstrap(client)["payment_methods"][0]

    layby = client.post("/api/laybys", json={
        "customer_id": customer["id"],
        "lines": [{"product_id": product["id"], "qty": 2}],
        "deposit_amount": "50.00",
        "payment_method_id": method["id"],
        "due_date": (date.today() + timedelta(days=30)).isoformat(),
    }, headers=headers).get_json()["item"]
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 6

    balance = layby["balance_cents"]
    paid = client.post(f"/api/laybys/{layby['id']}/payments",
                       json={"amount": f"{balance / 100:.2f}", "payment_method_id": method["id"]},
                       headers=headers)
    assert paid.status_code == 200, paid.get_json()

    # Paying the balance settles the lay-by automatically.
    settled = client.get(f"/api/laybys/{layby['id']}", headers=headers).get_json()["item"]
    assert settled["status"] == "completed"
    sale = client.get(f"/api/sales/{settled['sale_id']}", headers=headers).get_json()["item"]
    # Two units come from the oldest layer (4 units bought at 40.00 each).
    assert sale["cost_cents"] == 2 * 4000
    # Completing the lay-by must not take the goods out of stock a second time.
    assert client.get(f"/api/products/{product['id']}", headers=headers).get_json()["item"]["stock_qty"] == 6


def test_activity_log_lists_workspace_actions(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product["id"], method["id"], product["price_cents"])

    feed = client.get("/api/activity", headers=headers)
    assert feed.status_code == 200, feed.get_json()
    payload = feed.get_json()
    actions = {item["action"] for item in payload["items"]}
    assert "sale.completed" in actions
    assert any(item["action"] == "product.created" for item in payload["items"])
    assert payload["meta"]["total"] >= 2
    assert all(item["actor"] for item in payload["items"])

    filtered = client.get("/api/activity", query_string={"area": "sale"}, headers=headers).get_json()
    assert {item["action"] for item in filtered["items"]} == {"sale.completed"}

    facets = client.get("/api/activity/facets", headers=headers)
    assert facets.status_code == 200, facets.get_json()
    assert "sale" in {area["key"] for area in facets.get_json()["areas"]}


def test_summary_pdf_breaks_down_by_branch_and_department(client, owner):
    headers = owner["headers"]
    product = make_product(client, headers)
    method = bootstrap(client)["payment_methods"][0]
    checkout(client, headers, product["id"], method["id"], product["price_cents"])

    params = {"from": (date.today() - timedelta(days=1)).isoformat(),
              "to": (date.today() + timedelta(days=1)).isoformat()}
    response = client.get("/api/reports/summary.pdf", query_string=params, headers=headers)
    assert response.status_code == 200, response.get_json()
    assert response.data.startswith(b"%PDF")

    try:
        import pymupdf
    except ImportError:  # pragma: no cover - optional dependency
        return
    with pymupdf.open(stream=response.data, filetype="pdf") as doc:
        text = "\n".join(page.get_text() for page in doc)
    assert "Sales by branch" in text
    assert "Sales by department" in text
    # A summary aggregates: no day-on-day ledger table in here.
    assert "SHARE" in text.upper()
    assert "DATE" not in text.upper()


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
