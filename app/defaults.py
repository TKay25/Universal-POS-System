"""Permission catalogue, default roles and default company settings."""

from __future__ import annotations

from copy import deepcopy

PERMISSIONS: list[dict] = [
    {"key": "pos.sell", "label": "Sell at the POS", "group": "Selling"},
    {"key": "pos.override", "label": "Override prices at checkout", "group": "Selling"},
    {"key": "sales.view_all", "label": "View all sales (not just own)", "group": "Sales"},
    {"key": "sales.refund", "label": "Issue refunds", "group": "Sales"},
    {"key": "sales.void", "label": "Void completed sales", "group": "Sales"},
    {"key": "products.manage", "label": "Manage products & categories", "group": "Catalog"},
    {"key": "inventory.manage", "label": "Adjust and receive stock", "group": "Catalog"},
    {"key": "customers.manage", "label": "Manage customers", "group": "Customers"},
    {"key": "discounts.manage", "label": "Manage discounts & promotions", "group": "Selling"},
    {"key": "reports.view", "label": "View reports", "group": "Reports"},
    {"key": "reports.export", "label": "Export report data", "group": "Reports"},
    {"key": "shifts.manage", "label": "Open and close shifts", "group": "Operations"},
    {"key": "settings.manage", "label": "Manage company settings", "group": "Administration"},
    {"key": "users.manage", "label": "Manage users & roles", "group": "Administration"},
    {"key": "audit.view", "label": "View the audit log", "group": "Administration"},
]

PERMISSION_KEYS = {p["key"] for p in PERMISSIONS}

DEFAULT_ROLES: list[dict] = [
    {
        "name": "Administrator",
        "description": "Full control of the company workspace.",
        "system": True,
        "permissions": sorted(PERMISSION_KEYS),
    },
    {
        "name": "Manager",
        "description": "Runs day-to-day operations and staff.",
        "system": False,
        "permissions": [
            "pos.sell", "pos.override", "sales.view_all", "sales.refund", "sales.void",
            "products.manage", "inventory.manage", "customers.manage", "discounts.manage",
            "reports.view", "reports.export", "shifts.manage", "settings.manage",
            "users.manage", "audit.view",
        ],
    },
    {
        "name": "Cashier",
        "description": "Sells and looks after customers at the till.",
        "system": False,
        "permissions": ["pos.sell", "customers.manage", "shifts.manage"],
    },
    {
        "name": "Accountant",
        "description": "Read-only access to money and reports.",
        "system": False,
        "permissions": ["sales.view_all", "reports.view", "reports.export", "audit.view"],
    },
]

DEFAULT_SETTINGS: dict = {
    "currency": {
        "code": "USD",
        "symbol": "$",
        "position": "before",
        "decimals": 2,
    },
    "business": {
        "legal_name": "",
        "tax_number": "",
        "company_reg_number": "",
        "email": "",
        "phone": "",
        "website": "",
        "address": "",
        "city": "",
        "country": "Zimbabwe",
    },
    "branding": {
        "logo_text": "",
        "logo_data_url": "",
        "primary": "#5b5bd6",
        "accent": "#22d3ee",
        "theme": "light",
        "radius": 14,
        "density": "comfortable",
    },
    "sales": {
        "prefix": "REC-",
        "next_number": 1,
        "number_padding": 5,
        "default_tax_rate_id": None,
        "default_payment_method_id": None,
        "allow_zero_price": False,
        "show_out_of_stock": True,
    },
    "receipts": {
        "paper_width": "80mm",
        "header_note": "",
        "terms": "Goods may be returned within 30 days with a valid receipt.",
        "thank_you": "Thank you for your business!",
    },
    "dashboard": {
        "widgets": [
            "sales_today",
            "transactions_today",
            "average_ticket",
            "low_stock",
            "sales_chart",
            "payment_mix",
            "top_products",
            "recent_sales",
        ],
    },
    "security": {
        "require_pin_for_override": True,
    },
}

DASHBOARD_WIDGETS = [
    {"key": "sales_today", "name": "Sales today", "size": "sm"},
    {"key": "transactions_today", "name": "Transactions today", "size": "sm"},
    {"key": "average_ticket", "name": "Average ticket", "size": "sm"},
    {"key": "low_stock", "name": "Low stock items", "size": "sm"},
    {"key": "sales_chart", "name": "Sales trend", "size": "lg"},
    {"key": "payment_mix", "name": "Payment mix", "size": "md"},
    {"key": "top_products", "name": "Top products", "size": "md"},
    {"key": "recent_sales", "name": "Recent sales", "size": "lg"},
    {"key": "category_mix", "name": "Category mix", "size": "md"},
    {"key": "hourly_heat", "name": "Busiest hours", "size": "md"},
]


def deep_merge(base: dict, patch: dict) -> dict:
    """Recursively merge ``patch`` into a copy of ``base``."""
    result = deepcopy(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def default_settings() -> dict:
    return deepcopy(DEFAULT_SETTINGS)
