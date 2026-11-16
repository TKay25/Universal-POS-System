"""Pricing engine unit tests — the money math must be exact."""

from __future__ import annotations

import pytest

from app.extensions import db
from app.models import Category, Company, Product, TaxRate
from app.services.pricing import price_cart


@pytest.fixture()
def shop(app):
    company = Company(name="Pricing Co", slug="pricing-co", status="active")
    db.session.add(company)
    db.session.flush()
    exclusive = TaxRate(company_id=company.id, name="VAT", rate=15.0, is_default=True)
    inclusive = TaxRate(company_id=company.id, name="Gross", rate=10.0, is_inclusive=True)
    db.session.add_all([exclusive, inclusive])
    db.session.flush()
    category = Category(company_id=company.id, name="Tests")

    a = Product(company_id=company.id, name="A", price_cents=1000, cost_cents=400, tax_rate_id=exclusive.id)
    b = Product(company_id=company.id, name="B", price_cents=500, cost_cents=200, tax_rate_id=inclusive.id)
    db.session.add_all([a, b])
    db.session.commit()
    return {"company": company, "a": a, "b": b}


def test_exclusive_and_inclusive_tax(shop):
    priced = price_cart(shop["company"], [{"product": shop["a"], "qty": 2}, {"product": shop["b"], "qty": 1}])
    assert priced["gross_subtotal_cents"] == 2500
    # A: 2000 * 15% = 300 ; B: 500 included at 10% => 45 (500 - 500/1.1)
    assert priced["tax_cents"] == 300 + 45
    assert priced["total_cents"] == 2345 + 500


def test_percentage_cart_discount_reduces_tax_proportionally(shop):
    priced = price_cart(
        shop["company"],
        [{"product": shop["a"], "qty": 1}],
        cart_discount={"type": "percent", "value": 10, "label": "Ten off"},
    )
    assert priced["discount_cents"] == 100
    assert priced["net_cents"] == 900
    assert priced["tax_cents"] == 135
    assert priced["total_cents"] == 1035


def test_discount_cannot_exceed_cart(shop):
    priced = price_cart(
        shop["company"],
        [{"product": shop["a"], "qty": 1}],
        cart_discount={"type": "fixed", "value": 999999},
    )
    assert priced["discount_cents"] == 1000
    assert priced["total_cents"] == 0


def test_rounding_module(shop):
    company = shop["company"]
    company.set_module("rounding", True, {"increment": 5, "mode": "nearest"})
    db.session.commit()
    priced = price_cart(company, [{"product": shop["a"], "qty": 1}])
    # 1000 + 150 = 1150 -> nearest 5 is exact, no rounding
    assert priced["total_cents"] == 1150

    priced = price_cart(company, [{"product": shop["a"], "qty": 1, "unit_price_cents": 1001}])
    # 1001 + 150.15 -> 1151.15 -> rounds to 1150
    assert priced["total_cents"] % 5 == 0


def test_loyalty_redemption_is_capped(shop):
    from app.models import Customer

    company = shop["company"]
    company.set_module("loyalty", True, {"redeem_value": 10, "points_per_100": 1})
    db.session.commit()
    customer = Customer(company_id=company.id, name="Saver", loyalty_points=500)
    db.session.add(customer)
    db.session.commit()

    priced = price_cart(company, [{"product": shop["a"], "qty": 1}], redeem_points=500, customer=customer)
    assert priced["loyalty_points_redeemed"] == 115
    assert priced["total_cents"] == 0
