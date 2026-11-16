"""Module catalog.

Every capability of the platform is a module. A company enables the modules it
needs and configures each one through a declarative schema that the frontend
renders automatically — no code changes required for a company to compose its own
POS.

Schema field types understood by the settings renderer:
    bool | number | text | textarea | select | color | money | tags
"""

from __future__ import annotations

from copy import deepcopy

MODULE_CATALOG: list[dict] = [
    {
        "key": "pos",
        "name": "Point of Sale",
        "category": "Selling",
        "icon": "cart",
        "description": "The checkout terminal: product grid, cart, payments and receipts.",
        "default": True,
        "locked": True,  # core module, cannot be disabled
        "permissions": ["pos.sell"],
        "schema": [
            {"key": "grid_columns", "label": "Product grid columns", "type": "number", "default": 4, "min": 2, "max": 8},
            {"key": "show_images", "label": "Show product images", "type": "bool", "default": True},
            {"key": "show_stock", "label": "Show stock on tiles", "type": "bool", "default": True},
            {"key": "quick_cash", "label": "Quick cash buttons", "type": "tags", "default": [500, 1000, 2000, 5000, 10000],
             "help": "Amounts in minor units (cents) shown as one-tap tender buttons."},
            {"key": "auto_print", "label": "Print receipt automatically", "type": "bool", "default": False},
            {"key": "ask_for_note", "label": "Prompt for an order note", "type": "bool", "default": False},
            {"key": "sound_enabled", "label": "Scan / add sound", "type": "bool", "default": True},
            {"key": "customer_required", "label": "Require a customer on every sale", "type": "bool", "default": False},
        ],
    },
    {
        "key": "barcode",
        "name": "Barcode Scanning",
        "category": "Selling",
        "icon": "barcode",
        "description": "Scan-to-cart, barcode search and printable barcode labels.",
        "default": True,
        "permissions": ["products.manage"],
        "schema": [
            {"key": "label_width_mm", "label": "Label width (mm)", "type": "number", "default": 50, "min": 20, "max": 120},
            {"key": "label_height_mm", "label": "Label height (mm)", "type": "number", "default": 25, "min": 10, "max": 80},
            {"key": "show_price_on_label", "label": "Print price on labels", "type": "bool", "default": True},
        ],
    },
    {
        "key": "inventory",
        "name": "Inventory Control",
        "category": "Operations",
        "icon": "box",
        "description": "Stock levels, adjustments, movements and low-stock alerts.",
        "default": True,
        "permissions": ["inventory.manage"],
        "schema": [
            {"key": "low_stock_threshold", "label": "Default low-stock threshold", "type": "number", "default": 5, "min": 0, "max": 10000},
            {"key": "allow_negative", "label": "Allow selling out-of-stock items", "type": "bool", "default": False},
            {"key": "receive_reason_required", "label": "Require a reason for adjustments", "type": "bool", "default": True},
        ],
    },
    {
        "key": "customers",
        "name": "Customer Directory",
        "category": "Relationships",
        "icon": "users",
        "description": "Customer records, purchase history and store credit.",
        "default": True,
        "permissions": ["customers.manage"],
        "schema": [
            {"key": "require_phone", "label": "Require a phone number", "type": "bool", "default": False},
            {"key": "allow_credit", "label": "Enable store credit accounts", "type": "bool", "default": True},
            {"key": "default_credit_limit", "label": "Default credit limit", "type": "money", "default": 0},
        ],
    },
    {
        "key": "loyalty",
        "name": "Loyalty Points",
        "category": "Relationships",
        "icon": "star",
        "description": "Earn and redeem points on every purchase.",
        "default": False,
        "permissions": ["customers.manage"],
        "schema": [
            {"key": "points_per_100", "label": "Points earned per 100 spent", "type": "number", "default": 1, "min": 0, "max": 1000},
            {"key": "redeem_value", "label": "Value of 1 point", "type": "money", "default": 1},
            {"key": "minimum_redeem", "label": "Minimum points to redeem", "type": "number", "default": 100, "min": 0},
        ],
    },
    {
        "key": "discounts",
        "name": "Discounts & Promotions",
        "category": "Selling",
        "icon": "tag",
        "description": "Promo codes, percentage and fixed-amount cart discounts.",
        "default": True,
        "permissions": ["discounts.manage"],
        "schema": [
            {"key": "allow_manual", "label": "Allow manual discounts at checkout", "type": "bool", "default": True},
            {"key": "max_manual_percent", "label": "Maximum manual discount (%)", "type": "number", "default": 30, "min": 0, "max": 100},
            {"key": "require_code", "label": "Require a code for promotions", "type": "bool", "default": True},
        ],
    },
    {
        "key": "refunds",
        "name": "Refunds & Returns",
        "category": "Operations",
        "icon": "rotate",
        "description": "Full or partial refunds with restock tracking.",
        "default": True,
        "permissions": ["sales.refund"],
        "schema": [
            {"key": "restock_by_default", "label": "Restock returned items by default", "type": "bool", "default": True},
            {"key": "require_reason", "label": "Require a refund reason", "type": "bool", "default": True},
            {"key": "refund_window_days", "label": "Refund window (days)", "type": "number", "default": 30, "min": 0, "max": 365},
        ],
    },
    {
        "key": "shifts",
        "name": "Cash Drawer & Shifts",
        "category": "Operations",
        "icon": "clock",
        "description": "Open and close shifts with cash reconciliation.",
        "default": True,
        "permissions": ["shifts.manage"],
        "schema": [
            {"key": "require_open_shift", "label": "Require an open shift to sell", "type": "bool", "default": False},
            {"key": "count_payments", "label": "Require counted cash at close", "type": "bool", "default": True},
        ],
    },
    {
        "key": "holders",
        "name": "Held Orders",
        "category": "Selling",
        "icon": "pause",
        "description": "Park a cart and resume it later or on another register.",
        "default": True,
        "permissions": ["pos.sell"],
        "schema": [],
    },
    {
        "key": "order_notes",
        "name": "Line Item Notes",
        "category": "Selling",
        "icon": "note",
        "description": "Per-item notes for kitchens, gift wrapping or customisation.",
        "default": True,
        "permissions": ["pos.sell"],
        "schema": [
            {"key": "quick_notes", "label": "Quick note presets", "type": "tags",
             "default": ["No ice", "Extra hot", "Gift wrap", "No sugar", "Urgent"]},
        ],
    },
    {
        "key": "tips",
        "name": "Tips",
        "category": "Selling",
        "icon": "heart",
        "description": "Capture tips as a fixed amount or percentage of the sale.",
        "default": False,
        "permissions": ["pos.sell"],
        "schema": [
            {"key": "presets", "label": "Tip presets (%)", "type": "tags", "default": [5, 10, 15]},
            {"key": "allow_custom", "label": "Allow custom tip amount", "type": "bool", "default": True},
        ],
    },
    {
        "key": "service_charge",
        "name": "Service Charge",
        "category": "Selling",
        "icon": "receipt",
        "description": "Automatically add a service charge to every ticket.",
        "default": False,
        "permissions": ["pos.sell"],
        "schema": [
            {"key": "percent", "label": "Service charge (%)", "type": "number", "default": 10, "min": 0, "max": 100},
            {"key": "applies_to", "label": "Applies to", "type": "select", "default": "all", "options": ["all", "dine_in"]},
        ],
    },
    {
        "key": "tax_engine",
        "name": "Multi-Rate Tax Engine",
        "category": "Finance",
        "icon": "percent",
        "description": "Multiple tax rates, inclusive or exclusive pricing.",
        "default": True,
        "permissions": ["settings.manage"],
        "schema": [
            {"key": "prices_include_tax", "label": "Product prices include tax", "type": "bool", "default": False},
            {"key": "show_breakdown", "label": "Show tax breakdown on receipts", "type": "bool", "default": True},
        ],
    },
    {
        "key": "departments",
        "name": "Departments",
        "category": "Catalog",
        "icon": "layers",
        "description": "Group categories into departments such as Hardware, Kitchenware or Electronics.",
        "default": True,
        "permissions": ["products.manage"],
        "schema": [],
    },
    {
        "key": "layby",
        "name": "Lay-by / Layaway",
        "category": "Selling",
        "icon": "wallet",
        "description": "Take a deposit, reserve the goods and let customers pay the balance over time.",
        "default": True,
        "permissions": ["pos.sell"],
        "schema": [
            {"key": "deposit_percent", "label": "Minimum deposit (%)", "type": "number", "default": 20, "min": 0, "max": 100},
            {"key": "min_deposit", "label": "Minimum deposit amount", "type": "money", "default": 0},
            {"key": "max_days", "label": "Maximum lay-by period (days)", "type": "number", "default": 90, "min": 1, "max": 365},
            {"key": "cancellation_fee_percent", "label": "Cancellation fee (% of paid)", "type": "number", "default": 0, "min": 0, "max": 100},
            {"key": "restock_on_cancel", "label": "Return stock on cancellation", "type": "bool", "default": True},
            {"key": "require_customer", "label": "Require a registered customer", "type": "bool", "default": True},
        ],
    },
    {
        "key": "bulk_stock",
        "name": "Bulk Stock Tools",
        "category": "Operations",
        "icon": "upload",
        "description": "Excel-friendly templates to upload stock and audit stock counts on the floor.",
        "default": True,
        "permissions": ["inventory.manage"],
        "schema": [
            {"key": "create_missing_categories", "label": "Create missing departments/categories on import", "type": "bool", "default": True},
            {"key": "count_requires_reason", "label": "Require a note on stock counts", "type": "bool", "default": False},
        ],
    },
    {
        "key": "rounding",
        "name": "Cash Rounding",
        "category": "Finance",
        "icon": "coins",
        "description": "Round cash totals to the nearest increment.",
        "default": False,
        "permissions": ["settings.manage"],
        "schema": [
            {"key": "increment", "label": "Round to nearest", "type": "money", "default": 5},
            {"key": "mode", "label": "Mode", "type": "select", "default": "nearest", "options": ["nearest", "up", "down"]},
        ],
    },
    {
        "key": "reports",
        "name": "Reports & Analytics",
        "category": "Finance",
        "icon": "chart",
        "description": "Sales, tax, product, payment and inventory reports with CSV export.",
        "default": True,
        "permissions": ["reports.view"],
        "schema": [
            {"key": "default_range_days", "label": "Default report range (days)", "type": "number", "default": 30, "min": 1, "max": 365},
            {"key": "week_starts_on", "label": "Week starts on", "type": "select", "default": "monday", "options": ["monday", "sunday"]},
        ],
    },
    {
        "key": "receipts",
        "name": "Receipt Designer",
        "category": "Finance",
        "icon": "printer",
        "description": "Branded thermal or A4 receipts with barcodes and QR codes.",
        "default": True,
        "permissions": ["settings.manage"],
        "schema": [
            {"key": "template", "label": "Template", "type": "select", "default": "thermal", "options": ["thermal", "a4", "minimal"]},
            {"key": "show_logo", "label": "Show company logo", "type": "bool", "default": True},
            {"key": "show_barcode", "label": "Show receipt barcode", "type": "bool", "default": True},
            {"key": "show_qr", "label": "Show QR code", "type": "bool", "default": False},
            {"key": "show_cashier", "label": "Show cashier name", "type": "bool", "default": True},
            {"key": "footer_note", "label": "Footer note", "type": "textarea", "default": "Thank you for your business!"},
        ],
    },
    {
        "key": "multi_location",
        "name": "Multi-Location",
        "category": "Operations",
        "icon": "map",
        "description": "Manage several stores and registers under one company.",
        "default": False,
        "permissions": ["settings.manage"],
        "schema": [
            {"key": "show_location_on_receipt", "label": "Show location on receipts", "type": "bool", "default": True},
        ],
    },
    {
        "key": "custom_fields",
        "name": "Custom Fields",
        "category": "Customisation",
        "icon": "sliders",
        "description": "Add your own fields to products and customers.",
        "default": True,
        "permissions": ["settings.manage"],
        "schema": [],
    },
    {
        "key": "custom_workspaces",
        "name": "Custom Workspaces",
        "category": "Customisation",
        "icon": "sparkles",
        "description": "Build your own tabs with custom forms, tables and exports.",
        "default": True,
        "permissions": ["settings.manage"],
        "schema": [
            {"key": "max_workspaces", "label": "Maximum workspaces", "type": "number", "default": 10, "min": 1, "max": 40},
        ],
    },
    {
        "key": "audit_log",
        "name": "Activity & Audit Log",
        "category": "Governance",
        "icon": "shield",
        "description": "Immutable trail of every important action in the company.",
        "default": True,
        "permissions": ["audit.view"],
        "schema": [
            {"key": "retention_days", "label": "Retention (days)", "type": "number", "default": 365, "min": 7, "max": 3650},
        ],
    },
    {
        "key": "price_overrides",
        "name": "Price Overrides",
        "category": "Selling",
        "icon": "edit",
        "description": "Let trusted staff change a line price at checkout.",
        "default": False,
        "permissions": ["pos.override"],
        "schema": [
            {"key": "max_percent_below", "label": "Maximum discount below list (%)", "type": "number", "default": 20, "min": 0, "max": 100},
            {"key": "require_pin", "label": "Require a manager PIN", "type": "bool", "default": True},
        ],
    },
    {
        "key": "suppliers",
        "name": "Suppliers & Purchasing",
        "category": "Operations",
        "icon": "truck",
        "description": "Supplier records, purchase orders and receiving.",
        "default": False,
        "permissions": ["inventory.manage"],
        "schema": [
            {"key": "auto_receive", "label": "Auto-receive confirmed orders", "type": "bool", "default": True},
        ],
    },
    {
        "key": "credit_notes",
        "name": "Store Credit Notes",
        "category": "Finance",
        "icon": "wallet",
        "description": "Issue credit notes that customers can spend later.",
        "default": False,
        "permissions": ["sales.refund"],
        "schema": [
            {"key": "expiry_days", "label": "Credit note expiry (days)", "type": "number", "default": 365, "min": 1},
        ],
    },
]

MODULE_BY_KEY: dict[str, dict] = {m["key"]: m for m in MODULE_CATALOG}
CORE_MODULE_KEYS = {m["key"] for m in MODULE_CATALOG if m.get("default")}

MODULE_CATEGORIES = sorted({m["category"] for m in MODULE_CATALOG})


def module_defaults(key: str) -> dict:
    module = MODULE_BY_KEY.get(key, {})
    return {field["key"]: deepcopy(field.get("default")) for field in module.get("schema", [])}


def public_catalog() -> list[dict]:
    """Catalog as exposed to the UI, including per-field defaults."""
    return [
        {
            "key": m["key"],
            "name": m["name"],
            "category": m["category"],
            "icon": m["icon"],
            "description": m["description"],
            "default": m.get("default", False),
            "locked": m.get("locked", False),
            "permissions": m.get("permissions", []),
            "schema": m.get("schema", []),
            "config": module_defaults(m["key"]),
        }
        for m in MODULE_CATALOG
    ]
