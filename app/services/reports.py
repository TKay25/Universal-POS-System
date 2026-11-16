"""Reports & analytics.

Every report is declared once in :data:`REPORT_REGISTRY` and rendered by the
frontend from its column schema, which also makes CSV export automatic.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select

from app.extensions import db
from app.models import (
    Category,
    Customer,
    Layby,
    Location,
    Product,
    Refund,
    Sale,
    SaleItem,
    SalePayment,
    Shift,
    StockMovement,
    Supplier,
)
from app.utils import csv_response, day_buckets, iso
from app.services.timezones import local_date_sql, local_hour_sql, local_day_bounds, to_local

REVENUE_STATUSES = ("completed", "partially_refunded", "refunded")


def _sales_query(company_id: int, start: datetime, end: datetime):
    return select(Sale).where(
        Sale.company_id == company_id,
        Sale.created_at >= start,
        Sale.created_at <= end,
        Sale.status != "voided",
    )


def _scalar(stmt, default=0):
    value = db.session.execute(stmt).scalar()
    return default if value is None else value


def overview(company, start: datetime, end: datetime, location_id: int | None = None) -> dict:
    company_id = company.id
    statuses = REVENUE_STATUSES
    branch_clause = [Sale.location_id == location_id] if location_id else []

    totals = db.session.execute(
        select(
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.tax_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
            func.coalesce(func.sum(Sale.cost_cents), 0),
        ).where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
    ).one()
    sales_cents, transactions, tax_cents, discount_cents, refunded_cents, cost_cents = totals

    items = _scalar(
        select(func.coalesce(func.sum(SaleItem.qty), 0))
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
    )

    series_rows = db.session.execute(
        select(
            local_date_sql(Sale.created_at, company).label("day"),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
        )
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by("day")
        .order_by("day")
    ).all()
    by_day = {str(row[0]): {"sales_cents": int(row[1]), "transactions": int(row[2])} for row in series_rows}
    series = [
        {
            "date": day,
            "sales_cents": by_day.get(day, {}).get("sales_cents", 0),
            "transactions": by_day.get(day, {}).get("transactions", 0),
        }
        for day in day_buckets(to_local(start, company), to_local(end, company))
    ]

    payment_rows = db.session.execute(
        select(
            SalePayment.method_name,
            func.coalesce(func.sum(SalePayment.amount_cents), 0),
            func.count(SalePayment.id),
        )
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(SalePayment.method_name)
        .order_by(func.sum(SalePayment.amount_cents).desc())
    ).all()
    payment_mix = [
        {"name": row[0], "amount_cents": int(row[1]), "count": int(row[2])} for row in payment_rows
    ]

    top_rows = db.session.execute(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(SaleItem.name)
        .order_by(func.sum(SaleItem.qty).desc())
        .limit(8)
    ).all()
    top_products = [
        {"name": row[0], "qty": round(float(row[1]), 3), "revenue_cents": int(row[2])} for row in top_rows
    ]

    category_rows = db.session.execute(
        select(
            func.coalesce(Category.name, "Uncategorised"),
            func.coalesce(Category.color, "#94a3b8"),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .select_from(SaleItem)
        .join(Sale, Sale.id == SaleItem.sale_id)
        .outerjoin(Product, Product.id == SaleItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(Category.name, Category.color)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
        .limit(8)
    ).all()
    category_mix = [
        {"name": row[0], "color": row[1] or "#94a3b8", "revenue_cents": int(row[2])}
        for row in category_rows
    ]

    hourly_rows = db.session.execute(
        select(
            local_hour_sql(Sale.created_at, company),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.count(Sale.id),
        )
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(local_hour_sql(Sale.created_at, company))
    ).all()
    hourly_map = {int(row[0]): (int(row[1]), int(row[2])) for row in hourly_rows if row[0] is not None}
    hourly = [
        {"hour": hour, "sales_cents": hourly_map.get(hour, (0, 0))[0], "transactions": hourly_map.get(hour, (0, 0))[1]}
        for hour in range(24)
    ]

    recent = (
        db.session.execute(
            select(Sale)
            .where(Sale.company_id == company_id, *branch_clause)
            .order_by(Sale.created_at.desc())
            .limit(8)
        )
        .scalars()
        .all()
    )

    low_stock = (
        db.session.execute(
            select(Product)
            .where(
                Product.company_id == company_id,
                Product.is_active.is_(True),
                Product.track_stock.is_(True),
                Product.stock_qty <= Product.low_stock_threshold,
            )
            .order_by(Product.stock_qty.asc())
            .limit(20)
        )
        .scalars()
        .all()
    )

    gross_profit = int(sales_cents) - int(cost_cents)
    average = int(sales_cents) / transactions if transactions else 0
    ticket_average = int(sales_cents) / transactions if transactions else 0

    branch_rows = db.session.execute(
        select(
            func.coalesce(Location.name, "Unassigned"),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
        )
        .select_from(Sale)
        .outerjoin(Location, Location.id == Sale.location_id)
        .where(
            Sale.company_id == company_id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(statuses),
            *branch_clause,
        )
        .group_by(Location.name)
        .order_by(func.sum(Sale.total_cents).desc())
    ).all()

    return {
        "range": {"from": iso(start), "to": iso(end)},
        "branches": [
            {"name": row[0], "transactions": int(row[1]), "sales_cents": int(row[2])} for row in branch_rows
        ],
        "cards": {
            "sales_cents": int(sales_cents),
            "transactions": int(transactions),
            "average_ticket_cents": int(round(average)),
            "items_sold": round(float(items), 3),
            "tax_cents": int(tax_cents),
            "discount_cents": int(discount_cents),
            "refunded_cents": int(refunded_cents),
            "gross_profit_cents": gross_profit,
            "cost_cents": int(cost_cents),
            "ticket_average_cents": int(round(ticket_average)),
        },
        "series": series,
        "payment_mix": payment_mix,
        "top_products": top_products,
        "category_mix": category_mix,
        "hourly": hourly,
        "recent_sales": [s.to_dict() for s in recent],
        "low_stock": [p.to_dict() for p in low_stock],
    }


def today_dashboard(company) -> dict:
    start, end = local_day_bounds(company)
    return overview(company, start, end)


# --------------------------------------------------------------------------- #
# Tabular report registry
# --------------------------------------------------------------------------- #
def _rows(stmt):
    return [list(row) for row in db.session.execute(stmt).all()]


def report_sales(company, start, end):
    stmt = (
        select(
            Sale.number,
            Sale.created_at,
            Sale.status,
            func.coalesce(Customer.name, "Walk-in"),
            func.coalesce(Sale.total_cents, 0),
            func.coalesce(Sale.tax_cents, 0),
            func.coalesce(Sale.discount_cents, 0),
            func.coalesce(Sale.refunded_cents, 0),
            func.coalesce(Sale.user_id, 0),
        )
        .select_from(Sale)
        .outerjoin(Customer, Customer.id == Sale.customer_id)
        .where(Sale.company_id == company.id, Sale.created_at >= start, Sale.created_at <= end)
        .order_by(Sale.created_at.desc())
    )
    rows = _rows(stmt)
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
        row[8] = users.get(row[8], "—")
    return rows


def report_products(company, start, end):
    return _rows(
        select(
            SaleItem.name,
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
            func.coalesce(func.sum(SaleItem.discount_cents), 0),
            func.coalesce(func.sum(SaleItem.tax_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(SaleItem.name)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
    )


def report_categories(company, start, end):
    return _rows(
        select(
            func.coalesce(Category.name, "Uncategorised"),
            func.coalesce(func.sum(SaleItem.qty), 0),
            func.coalesce(func.sum(SaleItem.line_total_cents), 0),
        )
        .select_from(SaleItem)
        .join(Sale, Sale.id == SaleItem.sale_id)
        .outerjoin(Product, Product.id == SaleItem.product_id)
        .outerjoin(Category, Category.id == Product.category_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(Category.name)
        .order_by(func.sum(SaleItem.line_total_cents).desc())
    )


def report_payments(company, start, end):
    return _rows(
        select(
            SalePayment.method_name,
            func.count(SalePayment.id),
            func.coalesce(func.sum(SalePayment.amount_cents), 0),
            func.coalesce(func.sum(SalePayment.change_cents), 0),
        )
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(SalePayment.method_name)
        .order_by(func.sum(SalePayment.amount_cents).desc())
    )


def report_tax(company, start, end):
    return _rows(
        select(
            SaleItem.tax_rate_percent,
            func.coalesce(
                func.sum(SaleItem.line_subtotal_cents - SaleItem.discount_cents), 0
            ),
            func.coalesce(func.sum(SaleItem.tax_cents), 0),
        )
        .join(Sale, Sale.id == SaleItem.sale_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(SaleItem.tax_rate_percent)
        .order_by(SaleItem.tax_rate_percent)
    )


def report_cashiers(company, start, end):
    rows = _rows(
        select(
            func.coalesce(Sale.user_id, 0),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
        )
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(Sale.user_id)
    )
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[0] = users.get(row[0], "Deleted user")
    return rows


def report_inventory(company, start, end):
    return _rows(
        select(
            Product.name,
            Product.sku,
            Product.stock_qty,
            Product.low_stock_threshold,
            Product.cost_cents,
            Product.price_cents,
        )
        .where(Product.company_id == company.id, Product.is_active.is_(True))
        .order_by(Product.name)
    )


def report_stock_movements(company, start, end):
    rows = _rows(
        select(
            StockMovement.created_at,
            Product.name,
            StockMovement.qty_delta,
            StockMovement.balance_after,
            StockMovement.reason,
            StockMovement.reference,
        )
        .join(Product, Product.id == StockMovement.product_id)
        .where(
            StockMovement.company_id == company.id,
            StockMovement.created_at >= start,
            StockMovement.created_at <= end,
        )
        .order_by(StockMovement.created_at.desc())
        .limit(2000)
    )
    for row in rows:
        row[0] = row[0].strftime("%Y-%m-%d %H:%M") if row[0] else ""
    return rows


def report_customers(company, start, end):
    return _rows(
        select(
            Customer.name,
            Customer.email,
            Customer.phone,
            Customer.visits,
            Customer.total_spent_cents,
            Customer.loyalty_points,
            Customer.credit_balance_cents,
        )
        .where(Customer.company_id == company.id)
        .order_by(Customer.total_spent_cents.desc())
    )


def report_refunds(company, start, end):
    rows = _rows(
        select(
            Sale.number,
            Refund.created_at,
            Refund.amount_cents,
            Refund.method,
            Refund.reason,
            Refund.restock,
        )
        .join(Sale, Sale.id == Refund.sale_id)
        .where(Refund.company_id == company.id, Refund.created_at >= start, Refund.created_at <= end)
        .order_by(Refund.created_at.desc())
    )
    for row in rows:
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
    return rows


def report_shifts(company, start, end):
    rows = _rows(
        select(
            func.coalesce(Shift.user_id, 0),
            Shift.opened_at,
            Shift.closed_at,
            Shift.opening_float_cents,
            Shift.expected_cash_cents,
            Shift.counted_cash_cents,
            Shift.variance_cents,
        )
        .where(Shift.company_id == company.id, Shift.opened_at >= start, Shift.opened_at <= end)
        .order_by(Shift.opened_at.desc())
    )
    users = {u.id: u.full_name for u in company.users}
    for row in rows:
        row[0] = users.get(row[0], "—")
        row[1] = row[1].strftime("%Y-%m-%d %H:%M") if row[1] else ""
        row[2] = row[2].strftime("%Y-%m-%d %H:%M") if row[2] else "Open"
    return rows


def report_laybys(company, start, end):
    rows = _rows(
        select(
            Layby.number,
            func.coalesce(Customer.name, "Walk-in"),
            Layby.status,
            Layby.total_cents,
            Layby.paid_cents,
            Layby.due_date,
            Layby.created_at,
        )
        .select_from(Layby)
        .outerjoin(Customer, Customer.id == Layby.customer_id)
        .where(Layby.company_id == company.id, Layby.created_at >= start, Layby.created_at <= end)
        .order_by(Layby.created_at.desc())
    )
    for row in rows:
        row[5] = row[5].strftime("%Y-%m-%d") if row[5] else ""
        row[6] = row[6].strftime("%Y-%m-%d %H:%M") if row[6] else ""
    return rows


def report_branches(company, start, end):
    rows = _rows(
        select(
            func.coalesce(Location.name, "Unassigned"),
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.total_cents), 0),
            func.coalesce(func.sum(Sale.refunded_cents), 0),
            func.coalesce(func.sum(Sale.discount_cents), 0),
        )
        .select_from(Sale)
        .outerjoin(Location, Location.id == Sale.location_id)
        .where(
            Sale.company_id == company.id,
            Sale.created_at >= start,
            Sale.created_at <= end,
            Sale.status.in_(REVENUE_STATUSES),
        )
        .group_by(Location.name)
        .order_by(func.sum(Sale.total_cents).desc())
    )
    return rows


def report_suppliers(company, start, end):
    rows = _rows(
        select(Supplier.name, Supplier.contact_name, Supplier.phone, Supplier.email)
        .where(Supplier.company_id == company.id)
        .order_by(Supplier.name)
    )
    return rows


REPORT_REGISTRY: dict[str, dict] = {
    "sales": {
        "name": "Sales",
        "description": "Every transaction in the period with its financials.",
        "columns": [
            {"key": "number", "label": "Receipt", "type": "text"},
            {"key": "created_at", "label": "Date", "type": "text"},
            {"key": "status", "label": "Status", "type": "badge"},
            {"key": "customer", "label": "Customer", "type": "text"},
            {"key": "total", "label": "Total", "type": "money"},
            {"key": "tax", "label": "Tax", "type": "money"},
            {"key": "discount", "label": "Discount", "type": "money"},
            {"key": "refunded", "label": "Refunded", "type": "money"},
            {"key": "cashier", "label": "Cashier", "type": "text"},
        ],
        "build": report_sales,
    },
    "products": {
        "name": "Products sold",
        "description": "Quantity and revenue by product.",
        "columns": [
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "qty", "label": "Qty sold", "type": "number"},
            {"key": "revenue", "label": "Revenue", "type": "money"},
            {"key": "discount", "label": "Discount", "type": "money"},
            {"key": "tax", "label": "Tax", "type": "money"},
        ],
        "build": report_products,
    },
    "categories": {
        "name": "Categories",
        "description": "Revenue split across your categories.",
        "columns": [
            {"key": "category", "label": "Category", "type": "text"},
            {"key": "qty", "label": "Qty sold", "type": "number"},
            {"key": "revenue", "label": "Revenue", "type": "money"},
        ],
        "build": report_categories,
    },
    "payments": {
        "name": "Payments",
        "description": "Collected amounts grouped by payment method.",
        "columns": [
            {"key": "method", "label": "Method", "type": "text"},
            {"key": "count", "label": "Transactions", "type": "number"},
            {"key": "amount", "label": "Collected", "type": "money"},
            {"key": "change", "label": "Change given", "type": "money"},
        ],
        "build": report_payments,
    },
    "tax": {
        "name": "Tax",
        "description": "Tax collected per rate for filing.",
        "columns": [
            {"key": "rate", "label": "Rate %", "type": "percent"},
            {"key": "base", "label": "Taxable base", "type": "money"},
            {"key": "tax", "label": "Tax collected", "type": "money"},
        ],
        "build": report_tax,
    },
    "cashiers": {
        "name": "Cashiers",
        "description": "Performance by staff member.",
        "columns": [
            {"key": "user", "label": "Cashier", "type": "text"},
            {"key": "count", "label": "Transactions", "type": "number"},
            {"key": "total", "label": "Sales", "type": "money"},
            {"key": "discount", "label": "Discounts", "type": "money"},
            {"key": "refunded", "label": "Refunded", "type": "money"},
        ],
        "build": report_cashiers,
    },
    "inventory": {
        "name": "Inventory valuation",
        "description": "Current stock levels and stock value.",
        "columns": [
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "sku", "label": "SKU", "type": "text"},
            {"key": "stock", "label": "On hand", "type": "number"},
            {"key": "threshold", "label": "Low at", "type": "number"},
            {"key": "cost", "label": "Unit cost", "type": "money"},
            {"key": "price", "label": "Price", "type": "money"},
        ],
        "build": report_inventory,
    },
    "stock_movements": {
        "name": "Stock movements",
        "description": "Every stock change with its reason.",
        "columns": [
            {"key": "created_at", "label": "When", "type": "text"},
            {"key": "product", "label": "Product", "type": "text"},
            {"key": "delta", "label": "Change", "type": "number"},
            {"key": "balance", "label": "Balance", "type": "number"},
            {"key": "reason", "label": "Reason", "type": "badge"},
            {"key": "reference", "label": "Reference", "type": "text"},
        ],
        "build": report_stock_movements,
    },
    "customers": {
        "name": "Customers",
        "description": "Lifetime value and balances.",
        "columns": [
            {"key": "name", "label": "Customer", "type": "text"},
            {"key": "email", "label": "Email", "type": "text"},
            {"key": "phone", "label": "Phone", "type": "text"},
            {"key": "visits", "label": "Visits", "type": "number"},
            {"key": "spent", "label": "Lifetime spend", "type": "money"},
            {"key": "points", "label": "Points", "type": "number"},
            {"key": "credit", "label": "Store credit", "type": "money"},
        ],
        "build": report_customers,
    },
    "refunds": {
        "name": "Refunds",
        "description": "Returns issued in the period.",
        "columns": [
            {"key": "number", "label": "Receipt", "type": "text"},
            {"key": "created_at", "label": "When", "type": "text"},
            {"key": "amount", "label": "Amount", "type": "money"},
            {"key": "method", "label": "Method", "type": "badge"},
            {"key": "reason", "label": "Reason", "type": "text"},
            {"key": "restock", "label": "Restocked", "type": "bool"},
        ],
        "build": report_refunds,
    },
    "shifts": {
        "name": "Cash drawer",
        "description": "Shift reconciliation and variances.",
        "columns": [
            {"key": "cashier", "label": "Cashier", "type": "text"},
            {"key": "opened", "label": "Opened", "type": "text"},
            {"key": "closed", "label": "Closed", "type": "text"},
            {"key": "float", "label": "Opening float", "type": "money"},
            {"key": "expected", "label": "Expected", "type": "money"},
            {"key": "counted", "label": "Counted", "type": "money"},
            {"key": "variance", "label": "Variance", "type": "money"},
        ],
        "build": report_shifts,
    },
    "laybys": {
        "name": "Lay-bys",
        "description": "Agreements, deposits paid and balances outstanding.",
        "columns": [
            {"key": "number", "label": "Lay-by", "type": "text"},
            {"key": "customer", "label": "Customer", "type": "text"},
            {"key": "status", "label": "Status", "type": "badge"},
            {"key": "total", "label": "Total", "type": "money"},
            {"key": "paid", "label": "Paid", "type": "money"},
            {"key": "due", "label": "Due date", "type": "text"},
            {"key": "created_at", "label": "Opened", "type": "text"},
        ],
        "build": report_laybys,
    },
    "branches": {
        "name": "Branches",
        "description": "Sales performance for every shop branch.",
        "columns": [
            {"key": "branch", "label": "Branch", "type": "text"},
            {"key": "transactions", "label": "Transactions", "type": "number"},
            {"key": "sales", "label": "Sales", "type": "money"},
            {"key": "refunds", "label": "Refunds", "type": "money"},
            {"key": "discounts", "label": "Discounts", "type": "money"},
        ],
        "build": report_branches,
    },
    "suppliers": {
        "name": "Suppliers",
        "description": "Your supplier directory.",
        "columns": [
            {"key": "name", "label": "Supplier", "type": "text"},
            {"key": "contact", "label": "Contact", "type": "text"},
            {"key": "phone", "label": "Phone", "type": "text"},
            {"key": "email", "label": "Email", "type": "text"},
        ],
        "build": report_suppliers,
    },
}


def public_registry(company) -> list[dict]:
    """Only expose reports whose module is enabled for the company."""
    gates = {
        "inventory": "inventory",
        "stock_movements": "inventory",
        "customers": "customers",
        "refunds": "refunds",
        "shifts": "shifts",
        "suppliers": "suppliers",
        "laybys": "layby",
        "tax": "tax_engine",
    }
    published = []
    for key, definition in REPORT_REGISTRY.items():
        module_key = gates.get(key)
        if module_key and not company.module_enabled(module_key):
            continue
        published.append(
            {
                "key": key,
                "name": definition["name"],
                "description": definition["description"],
                "columns": definition["columns"],
            }
        )
    return published


def build_report(company, key: str, start: datetime, end: datetime):
    definition = REPORT_REGISTRY.get(key)
    if definition is None:
        return None, None
    rows = definition["build"](company, start, end)
    return definition, rows


def report_csv(company, key: str, start: datetime, end: datetime):
    definition, rows = build_report(company, key, start, end)
    if definition is None:
        return None
    headers = [column["label"] for column in definition["columns"]]
    cleaned = []
    for row in rows:
        cleaned.append(["" if value is None else value for value in row])
    return csv_response(f"{key}-{start.date()}-to-{end.date()}.csv", headers, cleaned)
