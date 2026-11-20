"""Barcode studio: mint in-store codes and print label sheets.

Everything here is behind the optional ``barcode`` module. Codes are EAN-13 in
the GS1 in-store range so any retail scanner reads them, and a product that
already carries a code keeps it unless the caller explicitly asks to replace it.
"""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request

from app.extensions import db
from app.models import Product
from app.security import (
    audit,
    bad_request,
    company_required,
    current_company,
    login_required,
    module_required,
    permission_required,
)
from app.services.barcode import barcode_for, is_ean13, labels_html, new_code
from app.services.receipt import money

bp = Blueprint("barcodes", __name__, url_prefix="/api/barcodes")

PREVIEW_LIMIT = 12


def _ids_from(value) -> list[int]:
    if isinstance(value, str):
        value = [part for part in value.split(",") if part.strip()]
    if not isinstance(value, list):
        return []
    clean: list[int] = []
    for item in value:
        try:
            clean.append(int(item))
        except (TypeError, ValueError):
            continue
    return clean


def _products(company, ids: list[int]) -> list[Product]:
    query = Product.query.filter(Product.company_id == company.id)
    if ids:
        query = query.filter(Product.id.in_(ids))
    return query.order_by(Product.name.asc()).all()


def _label_options(payload: dict) -> dict:
    def number(key: str, low: float, high: float):
        raw = payload.get(key)
        if raw in (None, ""):
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise bad_request("Label sizes must be numbers.", {key: "Enter a number."})
        return max(low, min(high, value))

    return {
        "width_mm": number("width_mm", 20, 120),
        "height_mm": number("height_mm", 10, 80),
        "show_price": payload.get("show_price"),
        "copies": max(1, min(int(payload.get("copies") or 1), 200)),
        "layout": "roll" if str(payload.get("layout") or "") == "roll" else "sheet",
    }


@bp.get("/summary")
@login_required
@company_required
def barcode_summary():
    company = current_company()
    products = (
        Product.query.filter(Product.company_id == company.id, Product.is_active.is_(True))
        .order_by(Product.name.asc())
        .all()
    )
    config = company.module_config("barcode")
    missing = [p for p in products if not (p.barcode or "").strip()]
    foreign = [p for p in products if (p.barcode or "").strip() and not is_ean13(p.barcode.strip())]
    return jsonify(
        {
            "enabled": company.module_enabled("barcode"),
            "label": {
                "width_mm": float(config.get("label_width_mm") or 50),
                "height_mm": float(config.get("label_height_mm") or 25),
                "show_price": bool(config.get("show_price_on_label", True)),
            },
            "counts": {
                "products": len(products),
                "missing": len(missing),
                "foreign": len(foreign),
                "ready": len(products) - len(missing),
            },
            "missing": [{"id": p.id, "name": p.name, "sku": p.sku} for p in missing[:PREVIEW_LIMIT]],
        }
    )


@bp.post("/generate")
@login_required
@company_required
@module_required("barcode")
@permission_required("products.manage")
def generate_barcodes():
    company = current_company()
    payload = request.get_json(silent=True) or {}
    ids = _ids_from(payload.get("product_ids"))
    replace = bool(payload.get("replace"))

    products = _products(company, ids)
    if ids and not products:
        raise bad_request("Pick at least one product from this workspace.")
    if not ids and not replace:
        # No selection means "fill in the gaps", not "rewrite everything".
        products = [p for p in products if not (p.barcode or "").strip()]
    if not products:
        total_coded = Product.query.filter(
            Product.company_id == company.id,
            Product.barcode.isnot(None),
            Product.barcode != "",
        ).count()
        return jsonify({"items": [], "generated": 0, "kept": total_coded})

    taken = {
        row.barcode.strip()
        for row in Product.query.filter(Product.company_id == company.id).all()
        if (row.barcode or "").strip()
    }
    generated: list[Product] = []
    for product in products:
        current = (product.barcode or "").strip()
        if current and not replace:
            continue
        if current in taken:
            taken.discard(current)
        code = new_code(taken)
        taken.add(code)
        product.barcode = code
        generated.append(product)

    if generated:
        db.session.commit()
        audit(
            "barcode.generated",
            entity="company",
            entity_id=company.id,
            summary=f"Generated {len(generated)} barcode{'s' if len(generated) != 1 else ''}",
            company_id=company.id,
            commit=True,
        )
    return jsonify(
        {
            "items": [{"id": p.id, "name": p.name, "sku": p.sku, "barcode": p.barcode} for p in generated],
            "generated": len(generated),
            # Everything that already carried a code and was left alone.
            "kept": Product.query.filter(
                Product.company_id == company.id,
                Product.barcode.isnot(None),
                Product.barcode != "",
            ).count() - len(generated),
        }
    )


@bp.post("/preview")
@login_required
@company_required
@module_required("barcode")
@permission_required("products.manage")
def preview_labels():
    company = current_company()
    payload = request.get_json(silent=True) or {}
    products = _products(company, _ids_from(payload.get("product_ids")))
    if not products:
        raise bad_request("Pick at least one product to preview.")
    options = _label_options(payload)
    settings = company.settings
    items = []
    for product in products[:PREVIEW_LIMIT]:
        code = product.barcode or product.sku or f"P{product.id}"
        items.append(
            {
                "id": product.id,
                "name": product.name,
                "sku": product.sku,
                "barcode": product.barcode,
                "code": code,
                "price": money(product.price_cents, settings) if options["show_price"] is not False else "",
                "svg": barcode_for(code, height=30, module=1.15),
                "missing": not bool((product.barcode or "").strip()),
            }
        )
    return jsonify({"items": items, "total": len(products), "shown": len(items), "label": options})


@bp.get("/labels")
@login_required
@company_required
@module_required("barcode")
@permission_required("products.manage")
def print_labels():
    company = current_company()
    products = _products(company, _ids_from(request.args.get("ids", "")))
    if not products:
        raise bad_request("Pick at least one product to print.")
    options = _label_options(request.args.to_dict())
    html_page = labels_html(
        company,
        products,
        copies=options["copies"],
        layout=options["layout"],
        width_mm=options["width_mm"],
        height_mm=options["height_mm"],
        show_price=None if options["show_price"] is None else str(options["show_price"]) not in {"0", "false", "False"},
    )
    response = Response(html_page, mimetype="text/html")
    response.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'"
    return response
