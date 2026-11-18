"""Declarative base contract: the typed ``**kwargs`` constructor matches SQLAlchemy."""

from __future__ import annotations

import pytest

from app.extensions import db
from app.models import Base, Company, CompanyModule, Customer, Product


def test_models_accept_keyword_arguments(app):
    product = Product(name="Latte", sku="SKU-1", price_cents=1000, track_stock=False)
    assert (product.name, product.sku, product.price_cents) == ("Latte", "SKU-1", 1000)

    customer = Customer(name="Tendai", email="tendai@example.com")
    assert customer.name == "Tendai"


def test_models_reject_unknown_keyword_arguments(app):
    with pytest.raises(TypeError, match="invalid keyword argument"):
        Product(name="Latte", colour="red")


def test_relationships_can_be_passed_as_keywords(app):
    company = Company(name="Kwargs Co", slug="kwargs-co")
    db.session.add(company)
    db.session.flush()

    module = CompanyModule(company=company, key="layby", enabled=True)
    db.session.add(module)
    db.session.commit()

    assert module.company is company
    assert company.module_enabled("layby") is True


def test_base_is_abstract_and_shares_the_schema(app):
    assert Base.__abstract__ is True
    assert Base.metadata is Product.metadata
