"""Products, categories, stock and customers."""

from __future__ import annotations

import csv
import io
import re

from flask import Blueprint, jsonify, request

from app.blueprints.helpers import get_scoped
from app.extensions import db
from app.models import (
    Category,
    CustomField,
    Customer,
    Department,
    Product,
    Sale,
    SaleItem,
    StockMovement,
    Supplier,
    TaxRate,
)
from app.security import (
    audit,
    bad_request,
    company_required,
    current_company,
    current_user,
    login_required,
    module_required,
    not_found,
    permission_required,
)
from app.utils import csv_response, paginate, search_arg, to_cents, utcnow, validate

bp = Blueprint("catalog", __name__, url_prefix="/api")


def _custom_field_map(company, entity: str) -> dict[str, CustomField]:
    rows = CustomField.query.filter_by(company_id=company.id, entity=entity).all()
    return {row.key: row for row in rows}


def _validate_custom_values(company, entity: str, values) -> dict:
    if not isinstance(values, dict):
        return {}
    definitions = _custom_field_map(company, entity)
    clean: dict = {}
    errors: dict[str, str] = {}
    for key, definition in definitions.items():
        raw = values.get(key)
        if raw in (None, ""):
            if definition.required:
                errors[f"custom_fields.{key}"] = f"{definition.label} is required."
            continue
        if definition.type == "number":
            try:
                clean[key] = float(raw)
            except (TypeError, ValueError):
                errors[f"custom_fields.{key}"] = f"{definition.label} must be a number."
        elif definition.type == "bool":
            clean[key] = bool(raw)
        elif definition.type == "select":
            if str(raw) not in (definition.options or []):
                errors[f"custom_fields.{key}"] = f"{definition.label} has an invalid option."
            else:
                clean[key] = str(raw)
        else:
            clean[key] = str(raw)[:500]
    if errors:
        raise bad_request("Please review the highlighted fields.", errors)
    return clean


# --------------------------------------------------------------------------- #
# Categories
# --------------------------------------------------------------------------- #
@bp.get("/categories")
@login_required
@company_required
def list_categories():
    company = current_company()
    rows = Category.query.filter_by(company_id=company.id).order_by(Category.sort_order, Category.name).all()
    departments = Department.query.filter_by(company_id=company.id).order_by(Department.sort_order).all()
    return jsonify({"items": [c.to_dict() for c in rows], "departments": [d.to_dict() for d in departments]})


@bp.post("/categories")
@login_required
@company_required
@permission_required("products.manage")
def create_category():
    company = current_company()
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 80, "label": "Category name"},
            "color": {"type": "str", "default": "#5b5bd6", "max_len": 20},
            "sort_order": {"type": "int", "default": 100, "min": 0, "max": 9999},
            "department_id": {"type": "int", "default": None},
        },
    )
    if payload.get("department_id"):
        get_scoped(Department, payload["department_id"], company.id)
    category = Category(company_id=company.id, **payload)
    db.session.add(category)
    db.session.commit()
    audit("category.created", entity="category", entity_id=category.id,
          summary=f"Created category {category.name}", commit=True)
    return jsonify({"item": category.to_dict()}), 201


@bp.patch("/categories/<int:category_id>")
@login_required
@company_required
@permission_required("products.manage")
def update_category(category_id: int):
    company = current_company()
    category = get_scoped(Category, category_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 80},
            "color": {"type": "str", "max_len": 20},
            "sort_order": {"type": "int", "min": 0, "max": 9999},
            "is_active": {"type": "bool"},
            "department_id": {"type": "int", "default": None, "allow_blank": True},
        },
    )
    if payload.get("department_id"):
        get_scoped(Department, payload["department_id"], company.id)
    if "department_id" in payload and payload["department_id"] is None:
        category.department_id = None
        payload.pop("department_id")
    for key, value in payload.items():
        setattr(category, key, value)
    db.session.commit()
    return jsonify({"item": category.to_dict()})


@bp.delete("/categories/<int:category_id>")
@login_required
@company_required
@permission_required("products.manage")
def delete_category(category_id: int):
    company = current_company()
    category = get_scoped(Category, category_id, company.id)
    Product.query.filter_by(company_id=company.id, category_id=category.id).update({"category_id": None})
    db.session.delete(category)
    db.session.commit()
    audit("category.deleted", entity="category", entity_id=category_id,
          summary=f"Deleted category {category.name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Departments
# --------------------------------------------------------------------------- #
@bp.get("/departments")
@login_required
@company_required
def list_departments():
    company = current_company()
    rows = Department.query.filter_by(company_id=company.id).order_by(Department.sort_order, Department.name).all()
    return jsonify({"items": [row.to_dict() for row in rows]})


@bp.post("/departments")
@login_required
@company_required
@permission_required("products.manage")
def create_department():
    company = current_company()
    if not company.module_enabled("departments"):
        raise bad_request("Enable the Departments module in settings first.")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 90, "label": "Department name"},
            "description": {"type": "str", "default": "", "max_len": 240},
            "color": {"type": "str", "default": "#5b5bd6", "max_len": 20},
            "icon": {"type": "str", "default": "layers", "max_len": 40},
            "sort_order": {"type": "int", "default": 100, "min": 0, "max": 9999},
            "is_active": {"type": "bool", "default": True},
        },
    )
    if Department.query.filter_by(company_id=company.id, name=payload["name"]).first():
        raise bad_request("A department with that name already exists.", {"name": "Name already used."})
    department = Department(company_id=company.id, **payload)
    db.session.add(department)
    db.session.commit()
    audit("department.created", entity="department", entity_id=department.id,
          summary=f"Created department {department.name}", commit=True)
    return jsonify({"item": department.to_dict()}), 201


@bp.patch("/departments/<int:department_id>")
@login_required
@company_required
@permission_required("products.manage")
def update_department(department_id: int):
    company = current_company()
    department = get_scoped(Department, department_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 90},
            "description": {"type": "str", "max_len": 240},
            "color": {"type": "str", "max_len": 20},
            "icon": {"type": "str", "max_len": 40},
            "sort_order": {"type": "int", "min": 0, "max": 9999},
            "is_active": {"type": "bool"},
        },
    )
    for key, value in payload.items():
        setattr(department, key, value)
    db.session.commit()
    audit("department.updated", entity="department", entity_id=department.id,
          summary=f"Updated department {department.name}", commit=True)
    return jsonify({"item": department.to_dict()})


@bp.delete("/departments/<int:department_id>")
@login_required
@company_required
@permission_required("products.manage")
def delete_department(department_id: int):
    company = current_company()
    department = get_scoped(Department, department_id, company.id)
    Category.query.filter_by(company_id=company.id, department_id=department.id).update({"department_id": None})
    Product.query.filter_by(company_id=company.id, department_id=department.id).update({"department_id": None})
    name = department.name
    db.session.delete(department)
    db.session.commit()
    audit("department.deleted", entity="department", entity_id=department_id,
          summary=f"Deleted department {name}", commit=True)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# Products
# --------------------------------------------------------------------------- #
@bp.get("/products")
@login_required
@company_required
def list_products():
    company = current_company()
    query = Product.query.filter_by(company_id=company.id)
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(
            db.or_(Product.name.ilike(like), Product.sku.ilike(like), Product.barcode.ilike(like))
        )
    category_id = request.args.get("category_id", type=int)
    if category_id:
        query = query.filter(Product.category_id == category_id)
    department_id = request.args.get("department_id", type=int)
    if department_id:
        query = query.filter(
            db.or_(
                Product.department_id == department_id,
                Product.category_id.in_(
                    db.select(Category.id).where(Category.department_id == department_id)
                ),
            )
        )
    if request.args.get("low_stock") == "1":
        query = query.filter(Product.track_stock.is_(True), Product.stock_qty <= Product.low_stock_threshold)
    if request.args.get("active") != "all":
        query = query.filter(Product.is_active.is_(True))

    items, meta = paginate(query.order_by(Product.name), default_per_page=50)
    return jsonify(
        {
            "items": [p.to_dict() for p in items],
            "meta": meta,
            "custom_fields": [f.to_dict() for f in _custom_field_map(company, "product").values()],
        }
    )


@bp.get("/products/lookup")
@login_required
@company_required
def lookup_product():
    company = current_company()
    code = (request.args.get("code") or "").strip()
    if not code:
        raise bad_request("Provide a barcode or SKU to look up.")
    product = Product.query.filter(
        Product.company_id == company.id,
        db.or_(Product.barcode == code, Product.sku == code),
    ).first()
    if product is None:
        not_found("No product matches that code.")
    return jsonify({"item": product.to_dict()})


def _product_payload(company, *, partial: bool):
    rules = {
        "name": {"type": "str", "max_len": 160, "label": "Product name"},
        "sku": {"type": "str", "default": "", "max_len": 60},
        "barcode": {"type": "str", "default": "", "max_len": 60},
        "description": {"type": "str", "default": "", "max_len": 2000},
        "category_id": {"type": "int", "default": None},
        "department_id": {"type": "int", "default": None},
        "tax_rate_id": {"type": "int", "default": None},
        "price": {"type": "money", "required": not partial, "label": "Price"},
        "cost": {"type": "money", "default": 0},
        "unit": {"type": "str", "default": "unit", "max_len": 20},
        "track_stock": {"type": "bool", "default": True},
        "stock_qty": {"type": "float", "default": 0},
        "low_stock_threshold": {"type": "int", "default": 5, "min": 0, "max": 100000},
        "color": {"type": "str", "default": "#5b5bd6", "max_len": 20},
        "icon": {"type": "str", "default": "box", "max_len": 40},
        "emoji": {"type": "str", "default": "", "max_len": 8},
        "image": {"type": "str", "default": "", "max_len": 255},
        "is_active": {"type": "bool", "default": True},
        "is_featured": {"type": "bool", "default": False},
        "custom_fields": {"type": "json", "default": {}},
    }
    if partial:
        rules["name"]["required"] = False
    payload = validate(request.get_json(silent=True) or {}, rules)

    if "category_id" in payload and payload["category_id"]:
        category = get_scoped(Category, payload["category_id"], company.id)
        if not payload.get("department_id"):
            payload["department_id"] = category.department_id
    if "department_id" in payload and payload["department_id"]:
        get_scoped(Department, payload["department_id"], company.id)
    if "price" in payload:
        payload["price_cents"] = payload.pop("price")
    if "cost" in payload:
        payload["cost_cents"] = payload.pop("cost")
    if "custom_fields" in payload:
        payload["custom_fields"] = _validate_custom_values(company, "product", payload["custom_fields"])
    return payload


def _ensure_unique_codes(company, *, sku: str = "", barcode: str = "", exclude_id: int | None = None):
    """Block duplicate SKUs/barcodes so stock never splits across two records."""
    sku = (sku or "").strip()
    barcode = (barcode or "").strip()
    if sku:
        clash = Product.query.filter(
            Product.company_id == company.id, db.func.lower(Product.sku) == sku.lower()
        ).first()
        if clash is not None and clash.id != exclude_id:
            raise bad_request(
                f"SKU '{sku}' already belongs to {clash.name}. Receive stock against it instead.",
                {"sku": f"Already used by {clash.name}."},
            )
    if barcode:
        clash = Product.query.filter(
            Product.company_id == company.id, Product.barcode == barcode
        ).first()
        if clash is not None and clash.id != exclude_id:
            raise bad_request(
                f"Barcode '{barcode}' already belongs to {clash.name}. Receive stock against it instead.",
                {"barcode": f"Already used by {clash.name}."},
            )


@bp.post("/products")
@login_required
@company_required
@permission_required("products.manage")
def create_product():
    company = current_company()
    payload = _product_payload(company, partial=False)
    _ensure_unique_codes(company, sku=payload.get("sku", ""), barcode=payload.get("barcode", ""))
    product = Product(company_id=company.id)
    for key, value in payload.items():
        setattr(product, key, value)
    db.session.add(product)
    db.session.flush()
    if product.stock_qty:
        db.session.add(
            StockMovement(
                company_id=company.id,
                product_id=product.id,
                user_id=current_user().id,
                qty_delta=product.stock_qty,
                balance_after=product.stock_qty,
                reason="opening",
                reference="initial stock",
            )
        )
    db.session.commit()
    audit("product.created", entity="product", entity_id=product.id,
          summary=f"Added {product.name}", commit=True)
    return jsonify({"item": product.to_dict()}), 201


@bp.get("/products/<int:product_id>")
@login_required
@company_required
def get_product(product_id: int):
    company = current_company()
    product = get_scoped(Product, product_id, company.id)
    movements = (
        StockMovement.query.filter_by(company_id=company.id, product_id=product.id)
        .order_by(StockMovement.created_at.desc())
        .limit(50)
        .all()
    )
    return jsonify({"item": product.to_dict(), "movements": [m.to_dict() for m in movements]})


@bp.patch("/products/<int:product_id>")
@login_required
@company_required
@permission_required("products.manage")
def update_product(product_id: int):
    company = current_company()
    product = get_scoped(Product, product_id, company.id)
    payload = _product_payload(company, partial=True)
    _ensure_unique_codes(
        company,
        sku=payload.get("sku", product.sku or ""),
        barcode=payload.get("barcode", product.barcode or ""),
        exclude_id=product.id,
    )
    manual_stock = "stock_qty" in payload
    if manual_stock:
        new_qty = payload.pop("stock_qty")
        delta = float(new_qty) - float(product.stock_qty or 0)
        if delta:
            product.stock_qty = round(float(new_qty), 3)
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=current_user().id,
                    qty_delta=delta,
                    balance_after=product.stock_qty,
                    reason="correction",
                    reference="edit form",
                )
            )
    for key, value in payload.items():
        setattr(product, key, value)
    db.session.commit()
    audit("product.updated", entity="product", entity_id=product.id,
          summary=f"Updated {product.name}", commit=True)
    return jsonify({"item": product.to_dict()})


@bp.delete("/products/<int:product_id>")
@login_required
@company_required
@permission_required("products.manage")
def delete_product(product_id: int):
    company = current_company()
    product = get_scoped(Product, product_id, company.id)
    sold = db.session.query(SaleItem.id).filter(SaleItem.product_id == product.id).first()
    if sold is not None:
        product.is_active = False
        db.session.commit()
        audit("product.archived", entity="product", entity_id=product.id,
              summary=f"Archived {product.name} (has sales history)", commit=True)
        return jsonify({"ok": True, "archived": True})
    db.session.delete(product)
    db.session.commit()
    audit("product.deleted", entity="product", entity_id=product_id,
          summary=f"Deleted {product.name}", commit=True)
    return jsonify({"ok": True})


@bp.post("/products/<int:product_id>/stock")
@login_required
@company_required
@permission_required("inventory.manage")
def adjust_stock(product_id: int):
    company = current_company()
    product = get_scoped(Product, product_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "mode": {"type": "str", "default": "delta", "choices": ["delta", "set"]},
            "qty": {"type": "float", "required": True, "label": "Quantity"},
            "reason": {"type": "str", "default": "adjustment",
                       "choices": ["adjustment", "receive", "wastage", "count", "return", "correction", "transfer"]},
            "reference": {"type": "str", "default": "", "max_len": 80},
            "note": {"type": "str", "default": "", "max_len": 240},
            "supplier_id": {"type": "int", "default": None},
            "buying_price": {"type": "money", "default": None},
            "selling_price": {"type": "money", "default": None},
        },
    )
    cfg = company.module_config("inventory")
    if cfg.get("receive_reason_required", True) and payload["reason"] in {"receive", "wastage"} and not payload["note"]:
        raise bad_request("Add a short note for this movement.", {"note": "A note is required."})
    supplier = None
    if payload["supplier_id"]:
        supplier = get_scoped(Supplier, payload["supplier_id"], company.id)

    before = float(product.stock_qty or 0)
    if payload["mode"] == "set":
        after = float(payload["qty"])
        delta = after - before
    else:
        delta = float(payload["qty"])
        after = before + delta
    if after < 0:
        raise bad_request("Stock cannot go below zero. Receive more stock instead.", {"qty": "Would be negative."})

    product.stock_qty = round(after, 3)
    if payload.get("buying_price") is not None:
        product.cost_cents = int(payload["buying_price"])
    if payload.get("selling_price") is not None:
        product.price_cents = int(payload["selling_price"])
    movement = StockMovement(
        company_id=company.id,
        product_id=product.id,
        supplier_id=supplier.id if supplier else None,
        user_id=current_user().id,
        qty_delta=round(delta, 3),
        balance_after=product.stock_qty,
        reason=payload["reason"],
        reference=payload["reference"],
        note=payload["note"],
    )
    db.session.add(movement)
    db.session.commit()
    audit("stock.adjusted", entity="product", entity_id=product.id,
          summary=f"{product.name}: {delta:+g} ({payload['reason']})",
          meta={"delta": delta, "balance": product.stock_qty}, commit=True)
    return jsonify({"item": product.to_dict(), "movement": movement.to_dict()})


@bp.get("/stock-movements")
@login_required
@company_required
@permission_required("inventory.manage")
def stock_movements():
    company = current_company()
    query = StockMovement.query.filter_by(company_id=company.id)
    product_id = request.args.get("product_id", type=int)
    if product_id:
        query = query.filter(StockMovement.product_id == product_id)
    items, meta = paginate(query.order_by(StockMovement.created_at.desc()), default_per_page=50)
    return jsonify({"items": [m.to_dict() for m in items], "meta": meta})


@bp.get("/products-export.csv")
@login_required
@company_required
@permission_required("products.manage")
def export_products():
    company = current_company()
    rows = Product.query.filter_by(company_id=company.id).order_by(Product.name).all()
    return csv_response(
        f"products-{utcnow().date()}.csv",
        ["Name", "SKU", "Barcode", "Category", "Price", "Cost", "Stock", "Unit", "Active"],
        [
            [
                p.name, p.sku, p.barcode, p.category.name if p.category else "",
                f"{(p.price_cents or 0) / 100:.2f}", f"{(p.cost_cents or 0) / 100:.2f}",
                f"{p.stock_qty:g}", p.unit, "yes" if p.is_active else "no",
            ]
            for p in rows
        ],
    )


@bp.get("/products/<int:product_id>/label")
@login_required
@company_required
@permission_required("products.manage")
def product_label(product_id: int):
    """Printable shelf/product label with a Code 128 barcode."""
    from app.services.receipt import barcode_svg, money as money_fmt

    company = current_company()
    product = get_scoped(Product, product_id, company.id)
    config = company.module_config("barcode")
    width = int(config.get("label_width_mm", 50) or 50)
    height = int(config.get("label_height_mm", 25) or 25)
    show_price = bool(config.get("show_price_on_label", True))
    code = product.barcode or product.sku or f"P{product.id}"
    svg = barcode_svg(code, height=30, module=1.2)
    settings = company.settings
    from flask import Response as FlaskResponse

    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{product.name} label</title>
<style>
  @page {{ size: {width}mm {height}mm; margin: 0; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font-family: "Segoe UI", Arial, sans-serif; }}
  .label {{ width: {width}mm; height: {height}mm; padding: 2mm 2.5mm; display: flex; flex-direction: column;
            justify-content: space-between; overflow: hidden; }}
  .name {{ font-size: 9.5px; font-weight: 700; line-height: 1.15; max-height: 2.4em; overflow: hidden; }}
  .sku {{ font-size: 6.5px; color: #444; letter-spacing: .04em; }}
  .code {{ text-align: center; margin-top: 1mm; }}
  .code svg {{ max-width: 100%; height: auto; }}
  .foot {{ display: flex; justify-content: space-between; align-items: baseline; font-size: 10px; }}
  .price {{ font-weight: 800; }}
  @media print {{ body {{ margin: 0; }} }}
</style></head>
<body><div class="label">
  <div><div class="name">{product.name}</div><div class="sku">{product.sku or ""}</div></div>
  <div class="code">{svg}</div>
  <div class="foot"><span class="sku">{code}</span>{f'<span class="price">{money_fmt(product.price_cents, settings)}</span>' if show_price else ''}</div>
</div></body></html>"""
    response = FlaskResponse(html, mimetype="text/html")
    response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'"
    return response


# --------------------------------------------------------------------------- #
# Bulk stock tools (Excel-compatible CSV)
# --------------------------------------------------------------------------- #
TEMPLATE_NEW_HEADERS = [
    "SKU", "Barcode", "Name", "Department", "Category", "Unit",
    "Buying Price", "Selling Price", "OpeningStock", "LowStockAt", "TaxRate", "Active",
]
TEMPLATE_COUNT_HEADERS = ["SKU", "Name", "Department", "Category", "SystemQty", "CountedQty"]


def _normalise_row(row: dict) -> dict:
    clean = {}
    for key, value in (row or {}).items():
        if key is None:
            continue
        spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(key).strip())
        normalised = "".join(ch if ch.isalnum() else "_" for ch in spaced.lower()).strip("_")
        clean[normalised] = ("" if value is None else str(value).strip())
    return clean


def _read_csv_rows():
    """Accept a multipart upload or a JSON body with a ``csv`` string."""
    raw = None
    upload = request.files.get("file")
    if upload is not None:
        raw = upload.read()
    else:
        payload = request.get_json(silent=True) or {}
        raw = payload.get("csv") or payload.get("content") or ""
        if isinstance(raw, str):
            raw = raw.encode("utf-8")
    if not raw:
        raise bad_request("Attach a CSV file or paste its contents.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")
    sample = text[:2048]
    delimiter = ","
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
    except csv.Error:
        delimiter = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    return [_normalise_row(row) for row in reader]


def _lookup_department(company, name: str, create: bool):
    name = (name or "").strip()
    if not name:
        return None
    found = Department.query.filter(
        Department.company_id == company.id, db.func.lower(Department.name) == name.lower()
    ).first()
    if found or not create:
        return found
    department = Department(company_id=company.id, name=name)
    db.session.add(department)
    db.session.flush()
    return department


def _lookup_category(company, name: str, department, create: bool):
    name = (name or "").strip()
    if not name:
        return None
    found = Category.query.filter(
        Category.company_id == company.id, db.func.lower(Category.name) == name.lower()
    ).first()
    if found:
        if department is not None and found.department_id is None:
            found.department_id = department.id
        return found
    if not create:
        return None
    category = Category(company_id=company.id, name=name, department_id=department.id if department else None)
    db.session.add(category)
    db.session.flush()
    return category


def _lookup_tax(company, raw: str):
    raw = (raw or "").strip()
    if not raw:
        return None
    rows = TaxRate.query.filter_by(company_id=company.id, is_active=True).all()
    for row in rows:
        if row.name.lower() == raw.lower():
            return row
    try:
        rate = float(raw.replace("%", "").strip())
    except ValueError:
        return None
    for row in rows:
        if abs(float(row.rate or 0) - rate) < 1e-6:
            return row
    return None


@bp.get("/inventory/template.csv")
@login_required
@company_required
@permission_required("inventory.manage")
def inventory_template():
    company = current_company()
    mode = request.args.get("mode", "new")
    if mode == "count":
        products = (
            Product.query.filter_by(company_id=company.id, is_active=True)
            .order_by(Product.name)
            .all()
        )
        rows = [
            [
                product.sku,
                product.name,
                product.department.name if product.department else (product.category.department.name if product.category and product.category.department else ""),
                product.category.name if product.category else "",
                f"{product.stock_qty:g}",
                "",
            ]
            for product in products
        ]
        return csv_response(f"stock-count-{utcnow().date()}.csv", TEMPLATE_COUNT_HEADERS, rows)

    sample = [
        ["SKU-9001", "200009001", "Cordless Drill 18V", "Hardware", "Power Tools", "unit", "65.00", "110.00", "12", "3", "15", "yes"],
        ["SKU-9002", "200009002", 'Smart TV 55"', "Electronics & Appliances", "TVs", "unit", "320.00", "499.00", "6", "2", "15", "yes"],
        ["SKU-9003", "200009003", "Ceramic Dinner Set", "Kitchenware", "Cookware", "set", "18.00", "35.00", "20", "5", "", "yes"],
    ]
    return csv_response(f"stock-import-template-{utcnow().date()}.csv", TEMPLATE_NEW_HEADERS, sample)


@bp.post("/inventory/import")
@login_required
@company_required
@module_required("bulk_stock")
@permission_required("inventory.manage")
def inventory_import():
    company = current_company()
    rows = _read_csv_rows()
    if not rows:
        raise bad_request("The file has no data rows.")
    cfg = company.module_config("bulk_stock")
    create_missing = bool(cfg.get("create_missing_categories", True))
    user = current_user()

    summary = {"created": 0, "updated": 0, "stock_adjusted": 0, "errors": [], "total": len(rows)}
    for index, row in enumerate(rows, start=2):
        sku = row.get("sku", "")
        barcode = row.get("barcode", "")
        name = row.get("name", "")
        if not name and not sku:
            summary["errors"].append({"row": index, "message": "Row has neither a name nor a SKU."})
            continue

        product = None
        if sku:
            product = Product.query.filter_by(company_id=company.id, sku=sku).first()
        if product is None and barcode:
            product = Product.query.filter_by(company_id=company.id, barcode=barcode).first()

        department = _lookup_department(company, row.get("department", ""), create_missing)
        category = _lookup_category(company, row.get("category", ""), department, create_missing)
        tax = _lookup_tax(company, row.get("tax_rate", row.get("tax", "")))

        price_raw = row.get("selling_price", row.get("price", ""))
        cost_raw = row.get("buying_price", row.get("cost", ""))
        stock_raw = row.get("opening_stock", row.get("stock", row.get("quantity", row.get("qty", ""))))
        threshold_raw = row.get("low_stock_at", row.get("min_stock", row.get("reorder_level", "")))
        active_raw = row.get("active", "")

        opening_stock = None
        if stock_raw not in ("", None):
            try:
                opening_stock = float(stock_raw)
            except ValueError:
                summary["errors"].append({"row": index, "message": f"Opening stock '{stock_raw}' is not a number."})
                continue

        if product is None:
            if not name:
                summary["errors"].append({"row": index, "message": "New products need a name."})
                continue
            if price_raw == "":
                summary["errors"].append({"row": index, "message": "New products need a price."})
                continue
            product = Product(
                company_id=company.id,
                name=name,
                sku=sku,
                barcode=barcode,
                unit=row.get("unit", "") or "unit",
                price_cents=to_cents(price_raw),
                cost_cents=to_cents(cost_raw) if cost_raw else 0,
                department_id=department.id if department else None,
                category_id=category.id if category else None,
                tax_rate_id=tax.id if tax else None,
                stock_qty=opening_stock or 0.0,
                low_stock_threshold=int(float(threshold_raw)) if threshold_raw else 5,
                is_active=(active_raw.lower() not in {"no", "false", "0", "inactive"}) if active_raw else True,
            )
            db.session.add(product)
            db.session.flush()
            summary["created"] += 1
            if opening_stock:
                db.session.add(
                    StockMovement(
                        company_id=company.id,
                        product_id=product.id,
                        user_id=user.id,
                        qty_delta=opening_stock,
                        balance_after=product.stock_qty,
                        reason="opening",
                        reference="bulk import",
                    )
                )
                summary["stock_adjusted"] += 1
        else:
            summary["updated"] += 1
            if name:
                product.name = name
            if barcode:
                product.barcode = barcode
            if sku:
                product.sku = sku
            if price_raw != "":
                product.price_cents = to_cents(price_raw)
            if cost_raw != "":
                product.cost_cents = to_cents(cost_raw)
            if row.get("unit"):
                product.unit = row["unit"]
            if department is not None:
                product.department_id = department.id
            if category is not None:
                product.category_id = category.id
            if tax is not None:
                product.tax_rate_id = tax.id
            if threshold_raw:
                product.low_stock_threshold = int(float(threshold_raw))
            if active_raw:
                product.is_active = active_raw.lower() not in {"no", "false", "0", "inactive"}
            if opening_stock is not None:
                delta = round(opening_stock - float(product.stock_qty or 0), 3)
                if delta:
                    product.stock_qty = opening_stock
                    db.session.add(
                        StockMovement(
                            company_id=company.id,
                            product_id=product.id,
                            user_id=user.id,
                            qty_delta=delta,
                            balance_after=product.stock_qty,
                            reason="import",
                            reference="bulk import",
                        )
                    )
                    summary["stock_adjusted"] += 1

    db.session.commit()
    audit("inventory.imported", entity="inventory", entity_id="bulk",
          summary=f"Bulk upload: {summary['created']} new, {summary['updated']} updated",
          meta={k: summary[k] for k in ("created", "updated", "stock_adjusted")}, commit=True)
    return jsonify(summary)


@bp.post("/inventory/count")
@login_required
@company_required
@module_required("bulk_stock")
@permission_required("inventory.manage")
def inventory_count():
    """Audit counted stock against the system and optionally apply variances."""
    company = current_company()
    rows = _read_csv_rows()
    if not rows:
        raise bad_request("The count sheet has no data rows.")
    apply_changes = str(request.args.get("apply", "1")).lower() not in {"0", "false", "no"}
    note = (request.get_json(silent=True) or {}).get("note", "") if request.is_json else ""
    user = current_user()

    variances = []
    errors = []
    applied = 0
    for index, row in enumerate(rows, start=2):
        sku = row.get("sku", "")
        barcode = row.get("barcode", "")
        counted_raw = row.get("counted_qty", row.get("counted", row.get("actual", "")))
        if counted_raw in ("", None):
            continue
        product = None
        if sku:
            product = Product.query.filter_by(company_id=company.id, sku=sku).first()
        if product is None and barcode:
            product = Product.query.filter_by(company_id=company.id, barcode=barcode).first()
        if product is None and row.get("name"):
            product = Product.query.filter_by(company_id=company.id, name=row["name"]).first()
        if product is None:
            errors.append({"row": index, "message": "No product matches that SKU/barcode."})
            continue
        try:
            counted = float(counted_raw)
        except ValueError:
            errors.append({"row": index, "message": f"Counted quantity '{counted_raw}' is not a number."})
            continue
        system_qty = float(product.stock_qty or 0)
        variance = round(counted - system_qty, 3)
        if variance == 0:
            continue
        variances.append(
            {
                "product_id": product.id,
                "sku": product.sku,
                "name": product.name,
                "system_qty": system_qty,
                "counted_qty": counted,
                "variance": variance,
                "value_cents": int(round(variance * (product.cost_cents or 0))),
            }
        )
        if apply_changes:
            product.stock_qty = counted
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=user.id,
                    qty_delta=variance,
                    balance_after=product.stock_qty,
                    reason="count",
                    reference="stock count",
                    note=(note or "Physical count")[:240],
                )
            )
            applied += 1

    if apply_changes:
        db.session.commit()
        audit("inventory.count_applied", entity="inventory", entity_id="count",
              summary=f"Stock count applied to {applied} products",
              meta={"variances": len(variances)}, commit=True)

    return jsonify(
        {
            "applied": applied,
            "variances": variances,
            "errors": errors,
            "mode": "applied" if apply_changes else "preview",
            "total_variance_value_cents": sum(row["value_cents"] for row in variances),
        }
    )


# --------------------------------------------------------------------------- #
# Customers
# --------------------------------------------------------------------------- #
@bp.get("/customers")
@login_required
@company_required
def list_customers():
    company = current_company()
    query = Customer.query.filter_by(company_id=company.id)
    term = search_arg()
    if term:
        like = f"%{term}%"
        query = query.filter(
            db.or_(Customer.name.ilike(like), Customer.email.ilike(like), Customer.phone.ilike(like))
        )
    items, meta = paginate(query.order_by(Customer.name), default_per_page=50)
    return jsonify(
        {
            "items": [c.to_dict() for c in items],
            "meta": meta,
            "custom_fields": [f.to_dict() for f in _custom_field_map(company, "customer").values()],
        }
    )


@bp.get("/customers/lookup")
@login_required
@company_required
def lookup_customer():
    company = current_company()
    term = (request.args.get("q") or "").strip()
    if not term:
        return jsonify({"items": []})
    like = f"%{term}%"
    rows = (
        Customer.query.filter(
            Customer.company_id == company.id,
            db.or_(Customer.name.ilike(like), Customer.phone.ilike(like), Customer.email.ilike(like)),
        )
        .order_by(Customer.name)
        .limit(12)
        .all()
    )
    return jsonify({"items": [c.to_dict() for c in rows]})


@bp.post("/customers")
@login_required
@company_required
@permission_required("customers.manage")
def create_customer():
    company = current_company()
    cfg = company.module_config("customers")
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "required": True, "max_len": 120, "label": "Customer name"},
            "email": {"type": "str", "default": "", "max_len": 180},
            "phone": {"type": "str", "default": "", "max_len": 40},
            "address": {"type": "str", "default": "", "max_len": 240},
            "tax_number": {"type": "str", "default": "", "max_len": 60},
            "notes": {"type": "str", "default": "", "max_len": 2000},
            "custom_fields": {"type": "json", "default": {}},
        },
    )
    if cfg.get("require_phone") and not payload["phone"]:
        raise bad_request("A phone number is required for new customers.", {"phone": "Phone is required."})
    payload["custom_fields"] = _validate_custom_values(company, "customer", payload["custom_fields"])
    customer = Customer(
        company_id=company.id,
        credit_limit_cents=int(cfg.get("default_credit_limit", 0) or 0),
        **payload,
    )
    db.session.add(customer)
    db.session.commit()
    audit("customer.created", entity="customer", entity_id=customer.id,
          summary=f"Added customer {customer.name}", commit=True)
    return jsonify({"item": customer.to_dict()}), 201


@bp.get("/customers/<int:customer_id>")
@login_required
@company_required
def get_customer(customer_id: int):
    company = current_company()
    customer = get_scoped(Customer, customer_id, company.id)
    sales = (
        Sale.query.filter_by(company_id=company.id, customer_id=customer.id)
        .order_by(Sale.created_at.desc())
        .limit(25)
        .all()
    )
    return jsonify(
        {
            "item": customer.to_dict(),
            "sales": [s.to_dict() for s in sales],
            "custom_fields": [f.to_dict() for f in _custom_field_map(company, "customer").values()],
        }
    )


@bp.patch("/customers/<int:customer_id>")
@login_required
@company_required
@permission_required("customers.manage")
def update_customer(customer_id: int):
    company = current_company()
    customer = get_scoped(Customer, customer_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "name": {"type": "str", "max_len": 120},
            "email": {"type": "str", "max_len": 180},
            "phone": {"type": "str", "max_len": 40},
            "address": {"type": "str", "max_len": 240},
            "tax_number": {"type": "str", "max_len": 60},
            "notes": {"type": "str", "max_len": 2000},
            "is_active": {"type": "bool"},
            "credit_limit": {"type": "money"},
            "custom_fields": {"type": "json"},
        },
    )
    if "credit_limit" in payload:
        customer.credit_limit_cents = payload.pop("credit_limit")
    if "custom_fields" in payload:
        customer.custom_fields = _validate_custom_values(company, "customer", payload.pop("custom_fields"))
    for key, value in payload.items():
        setattr(customer, key, value)
    db.session.commit()
    audit("customer.updated", entity="customer", entity_id=customer.id,
          summary=f"Updated customer {customer.name}", commit=True)
    return jsonify({"item": customer.to_dict()})


@bp.delete("/customers/<int:customer_id>")
@login_required
@company_required
@permission_required("customers.manage")
def delete_customer(customer_id: int):
    company = current_company()
    customer = get_scoped(Customer, customer_id, company.id)
    Sale.query.filter_by(company_id=company.id, customer_id=customer.id).update({"customer_id": None})
    db.session.delete(customer)
    db.session.commit()
    audit("customer.deleted", entity="customer", entity_id=customer_id,
          summary=f"Removed customer {customer.name}", commit=True)
    return jsonify({"ok": True})


@bp.post("/customers/<int:customer_id>/balance")
@login_required
@company_required
@permission_required("customers.manage")
def adjust_customer_balance(customer_id: int):
    company = current_company()
    customer = get_scoped(Customer, customer_id, company.id)
    payload = validate(
        request.get_json(silent=True) or {},
        {
            "kind": {"type": "str", "required": True, "choices": ["credit", "loyalty"], "label": "Balance type"},
            "amount": {"type": "float", "required": True, "label": "Amount"},
            "note": {"type": "str", "default": "", "max_len": 200},
        },
    )
    if payload["kind"] == "credit":
        delta = int(round(payload["amount"] * 100))
        if (customer.credit_balance_cents or 0) + delta < 0:
            raise bad_request("That would take the store credit below zero.", {"amount": "Too much."})
        customer.credit_balance_cents = (customer.credit_balance_cents or 0) + delta
        summary = f"Store credit {delta / 100:+.2f} for {customer.name}"
    else:
        delta = int(round(payload["amount"]))
        if (customer.loyalty_points or 0) + delta < 0:
            raise bad_request("That would take the points balance below zero.", {"amount": "Too much."})
        customer.loyalty_points = (customer.loyalty_points or 0) + delta
        summary = f"Loyalty {delta:+d} points for {customer.name}"
    db.session.commit()
    audit("customer.balance_adjusted", entity="customer", entity_id=customer.id,
          summary=summary, meta={"note": payload["note"]}, commit=True)
    return jsonify({"item": customer.to_dict()})
