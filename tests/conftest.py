"""Shared pytest fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app  # noqa: E402
from app.config import TestConfig  # noqa: E402
from app.extensions import db  # noqa: E402
from app.services.provisioning import add_user, provision_company  # noqa: E402


@pytest.fixture()
def app():
    application = create_app(TestConfig)
    with application.app_context():
        db.drop_all()
        db.create_all()
        yield application
        db.session.remove()


@pytest.fixture()
def client(app):
    return app.test_client()


def csrf(client) -> str:
    response = client.get("/api/auth/session")
    return response.get_json()["csrf_token"]


def login(client, email: str, password: str) -> dict:
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers={"X-CSRF-Token": csrf(client)},
    )
    assert response.status_code == 200, response.get_json()
    return {"X-CSRF-Token": response.get_json()["csrf_token"]}


@pytest.fixture()
def company(app):
    company = provision_company(
        "Test Company",
        status="active",
        plan="starter",
        currency_code="USD",
        currency_symbol="$",
    )
    owner = add_user(
        company,
        email="owner@test.dev",
        full_name="Test Owner",
        password="Password!1",
        role=company.owner_role,
    )
    db.session.commit()
    return {
        "id": company.id,
        "slug": company.slug,
        "email": owner.email,
        "password": "Password!1",
    }


@pytest.fixture()
def owner(client, company):
    headers = login(client, company["email"], company["password"])
    return {"headers": headers, "company": company}


@pytest.fixture()
def developer(app):
    from app.models import User

    user = User(email="dev@test.dev", full_name="Test Developer", is_developer=True)
    user.set_password("DevPassword!1")
    db.session.add(user)
    db.session.commit()
    return {"email": "dev@test.dev", "password": "DevPassword!1"}


@pytest.fixture()
def developer_headers(client, developer):
    return login(client, developer["email"], developer["password"])
