"""Deterministic demo data.

Seeding is idempotent: if the developer account already exists nothing is
touched, so restarting the server never duplicates records.
"""

from __future__ import annotations

import random
from datetime import timedelta

from app.defaults import DEFAULT_ROLES
from app.extensions import db
from app.models import (
    Announcement,
    Category,
    Company,
    CustomField,
    CustomWorkspace,
    Customer,
    Department,
    Discount,
    Location,
    PaymentMethod,
    Product,
    Register,
    Role,
    Sale,
    SaleItem,
    SalePayment,
    Shift,
    StockMovement,
    Supplier,
    TaxRate,
    User,
)
from app.services.checkout import next_sale_number
from app.services.laybys import add_payment, create_layby
from app.services.pricing import price_cart
from app.utils import utcnow

# name, department, category, price_cents, cost_cents, emoji, featured
COFFEE_PRODUCTS = [
    ("Espresso", "Coffee Bar", "Coffee", 250, 110, "cup-hot", True),
    ("Americano", "Coffee Bar", "Coffee", 300, 120, "cup-hot", True),
    ("Flat White", "Coffee Bar", "Coffee", 380, 160, "cup", True),
    ("Cappuccino", "Coffee Bar", "Coffee", 380, 155, "cup-hot", True),
    ("Caff? Latte", "Coffee Bar", "Coffee", 400, 165, "cup", True),
    ("Mocha", "Coffee Bar", "Coffee", 450, 190, "cup-hot", False),
    ("Cold Brew", "Coffee Bar", "Coffee", 420, 150, "cup-straw", True),
    ("Pour Over", "Coffee Bar", "Coffee", 480, 175, "cup", False),
    ("Croissant", "Bakery", "Bakery", 280, 110, "bread", True),
    ("Almond Croissant", "Bakery", "Bakery", 320, 135, "bread", False),
    ("Blueberry Muffin", "Bakery", "Bakery", 260, 95, "cake", False),
    ("Banana Bread", "Bakery", "Bakery", 240, 90, "bread", False),
    ("Cinnamon Roll", "Bakery", "Bakery", 300, 120, "cake", True),
    ("Ceramic Mug", "Merchandise", "Merch", 1500, 700, "cup", False),
    ("House Beans 250g", "Merchandise", "Merch", 1200, 620, "bag", True),
    ("Cold Cup 500ml", "Merchandise", "Merch", 1800, 900, "cup-straw", False),
]

ELECTRONICS_PRODUCTS = [
    ('Smart TV 55" 4K', "Electronics & Appliances", "TVs", 49900, 32000, "tv", True),
    ('Smart TV 32" HD', "Electronics & Appliances", "TVs", 24900, 16000, "tv", False),
    ("Soundbar 2.1", "Electronics & Appliances", "Audio", 12900, 7800, "speaker", False),
    ("Wireless Earbuds", "Electronics & Appliances", "Audio", 4999, 3200, "headset", True),
    ("Solar Panel 550W", "Electronics & Appliances", "Solar", 18500, 13000, "solar", True),
    ("Hybrid Inverter 3kW", "Electronics & Appliances", "Solar", 65000, 48000, "bolt", False),
    ("Lithium Battery 5kWh", "Electronics & Appliances", "Solar", 89000, 66000, "battery", True),
    ("Microwave 25L", "Electronics & Appliances", "Small Appliances", 15900, 10500, "microwave", True),
    ("Electric Kettle 1.7L", "Electronics & Appliances", "Small Appliances", 3500, 2100, "kettle", False),
    ("Cordless Drill 18V", "Hardware", "Power Tools", 11000, 6500, "drill", True),
    ("Angle Grinder 900W", "Hardware", "Power Tools", 8500, 5200, "tools", False),
    ("Paint Brush Set", "Hardware", "DIY", 1200, 600, "paint", False),
    ("Measuring Tape 5m", "Hardware", "DIY", 800, 350, "ruler", False),
    ("PVC Pipe 3m", "Hardware", "Plumbing", 1500, 900, "pipe", False),
    ("Tap Mixer", "Hardware", "Plumbing", 4200, 2600, "droplet", True),
    ("Petrol Generator 5.5kW", "Hardware", "Machinery", 78000, 60000, "fuel", False),
    ("3-Seater Sofa", "Furniture", "Living Room", 45000, 31000, "sofa", True),
    ("Coffee Table", "Furniture", "Living Room", 12000, 7500, "table", False),
    ("Office Desk 1.4m", "Furniture", "Office", 18000, 11000, "table", False),
    ("Ergonomic Chair", "Furniture", "Office", 15000, 9500, "chair", True),
    ("Ceramic Dinner Set 16pc", "Kitchenware", "Cookware", 3500, 1800, "plate", True),
    ("Non-stick Pot Set", "Kitchenware", "Cookware", 4200, 2400, "pot", False),
    ("Wine Glasses 6pc", "Kitchenware", "Glassware", 1800, 900, "glass", False),
]

DEPARTMENT_COLORS = {
    "Coffee Bar": "#b45309",
    "Bakery": "#d97706",
    "Merchandise": "#0f766e",
    "Electronics & Appliances": "#4338ca",
    "Hardware": "#b91c1c",
    "Furniture": "#0f766e",
    "Kitchenware": "#c2410c",
}


def _make_user(company, role, email, name, password, *, pin=None, color="#5b5bd6") -> User:
    user = User(
        company=company,
        role=role,
        email=email,
        full_name=name,
        status="active",
        avatar_color=color,
    )
    user.set_password(password)
    if pin:
        user.set_pin(pin)
    db.session.add(user)
    return user


def _make_roles(company) -> dict[str, Role]:
    roles: dict[str, Role] = {}
    for spec in DEFAULT_ROLES:
        role = Role(
            company=company,
            name=spec["name"],
            description=spec["description"],
            permissions=list(spec["permissions"]),
            is_system=spec.get("system", False),
        )
        db.session.add(role)
        roles[role.name] = role
    return roles


def _make_config(company, *, tax_name, tax_rate, currency, tax_number, company_reg_number, extra_methods=None):
    company.update_settings({
        "currency": currency,
        "business": {
            "legal_name": company.name,
            "email": f"hello@{company.slug}.example",
            "phone": "+263 24 270 0000",
            "website": f"https://{company.slug}.example",
            "address": "24 Market Street",
            "city": "Harare",
            "country": "Zimbabwe",
            "tax_number": tax_number,
            "company_reg_number": company_reg_number,
        },
    })

    location = Location(company=company, name="Main Store", code="MAIN", is_default=True)
    db.session.add(location)
    register = Register(company=company, location=location, name="Counter 1", code="C1")
    db.session.add(register)

    tax = TaxRate(company=company, name=tax_name, rate=tax_rate, is_default=True)
    db.session.add(tax)

    methods = [
        PaymentMethod(company=company, name="Cash", type="cash", icon="cash", opens_drawer=True, sort_order=10),
        PaymentMethod(company=company, name="Card", type="card", icon="card", sort_order=20),
        PaymentMethod(
            company=company, name="EcoCash", type="mobile", icon="phone",
            requires_reference=True, sort_order=30,
        ),
    ]
    methods += extra_methods or []
    for method in methods:
        db.session.add(method)
    return location, register, tax, methods


def _make_catalog(company, products, tax) -> list[Product]:
    departments: dict[str, Department] = {}
    categories: dict[str, Category] = {}

    for index, (_, department_name, category_name, *_rest) in enumerate(products):
        if department_name not in departments:
            department = Department(
                company=company,
                name=department_name,
                color=DEPARTMENT_COLORS.get(department_name, "#5b5bd6"),
                sort_order=len(departments) * 10,
                icon="layers",
            )
            db.session.add(department)
            departments[department_name] = department
        if category_name not in categories:
            category = Category(
                company=company,
                name=category_name,
                department=departments[department_name],
                color=DEPARTMENT_COLORS.get(department_name, "#5b5bd6"),
                sort_order=index * 10,
            )
            db.session.add(category)
            categories[category_name] = category

    created: list[Product] = []
    for index, (name, department_name, category_name, price, cost, icon_name, featured) in enumerate(products):
        product = Product(
            company=company,
            category=categories[category_name],
            department=departments[department_name],
            tax_rate=tax,
            name=name,
            sku=f"SKU-{1000 + index}",
            barcode=f"20{index:06d}",
            price_cents=price,
            cost_cents=cost,
            stock_qty=float(180 - index * 3),
            low_stock_threshold=10,
            icon=icon_name,
            emoji="",
            is_featured=featured,
            color=DEPARTMENT_COLORS.get(department_name, "#5b5bd6"),
            description=f"{name} — available in store.",
        )
        db.session.add(product)
        created.append(product)
    return created


def _make_customers(company, rows) -> list[Customer]:
    customers = []
    for name, email, phone, points in rows:
        customer = Customer(
            company=company,
            name=name,
            email=email,
            phone=phone,
            loyalty_points=points,
        )
        db.session.add(customer)
        customers.append(customer)
    return customers


def _seed_sale(company, *, user, customer, lines, method, when, shift=None,
               location_id=None, register_id=None):
    priced = price_cart(company, lines, customer=customer)
    sale = Sale(
        company_id=company.id,
        location_id=location_id,
        register_id=register_id,
        user_id=user.id,
        customer_id=customer.id if customer else None,
        shift_id=shift.id if shift else None,
        number=next_sale_number(company),
        status="completed",
        subtotal_cents=priced["subtotal_cents"],
        discount_cents=priced["discount_cents"],
        tax_cents=priced["tax_cents"],
        service_charge_cents=priced["service_charge_cents"],
        tip_cents=priced["tip_cents"],
        rounding_cents=priced["rounding_cents"],
        total_cents=priced["total_cents"],
        paid_cents=priced["total_cents"],
        change_cents=0,
        cost_cents=priced["cost_cents"],
        loyalty_points_earned=priced["loyalty_points_earned"],
        created_at=when,
    )
    db.session.add(sale)

    for line in priced["lines"]:
        product = line["product"]
        sale.items.append(
            SaleItem(
                product_id=product.id,
                name=product.name,
                sku=product.sku,
                qty=float(line["qty"]),
                unit_price_cents=line["unit_price_cents"],
                discount_cents=line["discount_cents"],
                tax_rate_percent=line["tax_rate_percent"],
                tax_cents=line["tax_cents"],
                line_subtotal_cents=line["line_subtotal_cents"],
                line_total_cents=line["line_total_cents"],
                cost_cents=line["cost_cents"],
            )
        )
        if product.track_stock:
            product.stock_qty = round((product.stock_qty or 0) - float(line["qty"]), 3)
            db.session.add(
                StockMovement(
                    company_id=company.id,
                    product_id=product.id,
                    user_id=user.id,
                    qty_delta=-float(line["qty"]),
                    balance_after=product.stock_qty,
                    reason="sale",
                    reference=sale.number,
                    created_at=when,
                )
            )

    sale.payments.append(
        SalePayment(
            method_id=method.id,
            method_name=method.name,
            method_type=method.type,
            amount_cents=priced["total_cents"],
            tendered_cents=priced["total_cents"],
            created_at=when,
        )
    )

    if customer is not None:
        customer.total_spent_cents = (customer.total_spent_cents or 0) + priced["total_cents"]
        customer.visits = (customer.visits or 0) + 1
        customer.last_visit_at = when
        customer.loyalty_points = (customer.loyalty_points or 0) + priced["loyalty_points_earned"]
    return sale


def _generate_sales(company, users, customers, products, methods, *, days, per_day, seed_value,
                    location=None, register=None):
    rng = random.Random(seed_value)
    now = utcnow()
    sellable_methods = [m for m in methods if m.type != "credit"] or methods
    shift = Shift(
        company_id=company.id,
        user_id=users[0].id,
        status="closed",
        opening_float_cents=10000,
        counted_cash_cents=0,
        expected_cash_cents=0,
        opened_at=now - timedelta(days=days, hours=2),
        closed_at=now - timedelta(days=days, hours=1),
    )
    db.session.add(shift)

    for day_offset in range(days, -1, -1):
        day = now - timedelta(days=day_offset)
        for _ in range(rng.randint(*per_day)):
            hour = rng.choice([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
            when = day.replace(hour=hour, minute=rng.randint(0, 59), second=rng.randint(0, 59))
            picks = rng.sample(products, k=rng.randint(1, min(4, len(products))))
            lines = [
                {"product": product, "qty": float(rng.choice([1, 1, 1, 2, 2, 3]))}
                for product in picks
            ]
            customer = rng.choice(customers) if customers and rng.random() < 0.55 else None
            method = rng.choice(sellable_methods)
            _seed_sale(
                company,
                user=rng.choice(users),
                customer=customer,
                lines=lines,
                method=method,
                when=when,
                shift=shift,
                location_id=location.id if location else None,
                register_id=register.id if register else None,
            )


def _seed_laybys(company, users, customers, products, methods, *, plans, seed_value):
    """Create realistic lay-bys from ``(customer_index, product_indexes, ratio, days, part_paid)`` plans."""
    db.session.flush()  # assign ids to freshly seeded customers and products
    rng = random.Random(seed_value)
    cash = next((m for m in methods if m.type == "cash"), methods[0])
    card = next((m for m in methods if m.type == "card"), methods[0])
    today = utcnow().date()

    for customer_index, product_indexes, ratio, days, follow_up in plans:
        customer = customers[customer_index]
        picks = [products[index] for index in product_indexes if index < len(products)]
        lines = [{"product_id": product.id, "qty": 1} for product in picks]
        priced = price_cart(company, [{"product": product, "qty": 1} for product in picks], customer=customer)
        deposit = max(int(round(priced["total_cents"] * ratio)), 100)
        layby = create_layby(
            company,
            rng.choice(users),
            {
                "customer_id": customer.id,
                "lines": lines,
                "deposit_amount": f"{deposit / 100:.2f}",
                "payment_method_id": cash.id,
                "due_date": (today + timedelta(days=days)).isoformat(),
                "note": "Customer will collect in store",
            },
        )
        if follow_up:
            extra = max(100, int(round(layby.balance_cents * 0.25)))
            add_payment(
                company,
                rng.choice(users),
                layby,
                {"amount": f"{extra / 100:.2f}", "payment_method_id": card.id, "reference": "LAYBY-INSTALMENT"},
            )


def seed_all(app) -> dict:
    if User.query.filter_by(is_developer=True).first() is not None:
        return {"seeded": False, "reason": "already initialised"}

    # ---- platform developer --------------------------------------------- #
    developer = User(
        email=app.config["DEVELOPER_EMAIL"].lower(),
        full_name="Platform Developer",
        is_developer=True,
        status="active",
        avatar_color="#0f172a",
    )
    developer.set_password(app.config["DEVELOPER_PASSWORD"])
    db.session.add(developer)
    db.session.flush()

    # ---- company one: Aurora Coffee Roasters ---------------------------- #
    aurora = Company(
        name="Aurora Coffee Roasters",
        slug="aurora-coffee",
        status="active",
        plan="growth",
        contact_email="hello@aurora-coffee.example",
        timezone="Africa/Harare",
        settings_json={
            "branding": {
                "logo_text": "Aurora Coffee",
                "primary": "#b45309",
                "accent": "#f59e0b",
                "theme": "light",
                "radius": 16,
            },
            "receipts": {"thank_you": "See you tomorrow — the first shot is on us!"},
        },
    )
    db.session.add(aurora)
    db.session.flush()

    aurora.location, aurora.register, aurora.tax, aurora.methods = _make_config(
        aurora,
        tax_name="VAT 15%",
        tax_rate=15.0,
        currency={"code": "USD", "symbol": "$", "position": "before", "decimals": 2},
        tax_number="VAT-4820193",
        company_reg_number="CR-2019/12345",
        extra_methods=[
            PaymentMethod(company=aurora, name="Store Credit", type="credit", icon="wallet", sort_order=40)
        ],
    )
    aurora_roles = _make_roles(aurora)
    aurora_owner = _make_user(
        aurora, aurora_roles["Administrator"], "owner@aurora.test", "Tariro Moyo", "Owner!2024", pin="1234"
    )
    aurora_cashier = _make_user(
        aurora, aurora_roles["Cashier"], "cashier@aurora.test", "Kudzai Ncube", "Cashier!2024",
        pin="4321", color="#0891b2",
    )
    aurora_manager = _make_user(
        aurora, aurora_roles["Manager"], "manager@aurora.test", "Rudo Chikafu", "Manager!2024",
        color="#7c3aed",
    )
    aurora.set_module("loyalty", True)
    aurora.set_module("tips", True)
    aurora.set_module("layby", True, {"deposit_percent": 20, "max_days": 60})

    aurora_products = _make_catalog(aurora, COFFEE_PRODUCTS, aurora.tax)
    aurora_customers = _make_customers(
        aurora,
        [
            ("Tendai Marufu", "tendai@example.com", "+263 771 000 111", 240),
            ("Nyasha Banda", "nyasha@example.com", "+263 771 000 222", 120),
            ("Farai Dube", "farai@example.com", "+263 771 000 333", 60),
            ("Rutendo Mutasa", "rutendo@example.com", "+263 771 000 444", 0),
            ("Simba Chirwa", "simba@example.com", "+263 771 000 555", 310),
        ],
    )

    db.session.add_all(
        [
            Discount(company=aurora, name="Welcome 10%", code="WELCOME10", type="percent", value=10.0),
            Discount(company=aurora, name="Loyalty $2 off", code="LOYAL2", type="fixed", value=2.0,
                     min_subtotal_cents=1500),
            Supplier(company=aurora, name="Highlands Roastery", contact_name="Peter Zulu",
                     phone="+263 771 500 100", email="orders@highlands.example"),
            Supplier(company=aurora, name="Dairy Fresh Ltd", contact_name="Memory Chirwa",
                     phone="+263 771 500 200", email="sales@dairyfresh.example"),
            CustomField(company=aurora, entity="product", key="allergens", label="Allergens", type="text"),
            CustomField(company=aurora, entity="customer", key="birthday", label="Birthday", type="date"),
        ]
    )

    _generate_sales(
        aurora,
        [aurora_owner, aurora_cashier, aurora_manager],
        aurora_customers,
        aurora_products,
        aurora.methods,
        days=44,
        per_day=(3, 9),
        seed_value=7,
        location=aurora.location,
        register=aurora.register,
    )

    # ---- company two: Nova Home & Tech ---------------------------------- #
    nova = Company(
        name="Nova Home & Tech",
        slug="nova-home-tech",
        status="active",
        plan="scale",
        contact_email="support@nova-home-tech.example",
        timezone="Africa/Harare",
        settings_json={
            "branding": {
                "logo_text": "Nova Home & Tech",
                "primary": "#4338ca",
                "accent": "#22d3ee",
                "theme": "dark",
                "radius": 12,
            },
            "receipts": {"thank_you": "Need help? support@nova-home-tech.example"},
        },
    )
    db.session.add(nova)
    db.session.flush()

    nova.location, nova.register, nova.tax, nova.methods = _make_config(
        nova,
        tax_name="VAT 15%",
        tax_rate=15.0,
        currency={"code": "USD", "symbol": "$", "position": "before", "decimals": 2},
        tax_number="VAT-7710455",
        company_reg_number="CR-2021/09876",
    )
    nova_roles = _make_roles(nova)
    nova_owner = _make_user(
        nova, nova_roles["Administrator"], "owner@nova.test", "Amelia Chen", "Owner!2024", pin="1234"
    )
    nova_manager = _make_user(
        nova, nova_roles["Manager"], "manager@nova.test", "Josh Patel", "Manager!2024", color="#4338ca"
    )
    nova.set_module("multi_location", True)
    nova.set_module("price_overrides", True)
    nova.set_module("rounding", True)
    nova.set_module("suppliers", True)
    nova.set_module("layby", True, {"deposit_percent": 25, "max_days": 90, "cancellation_fee_percent": 5})

    nova_products = _make_catalog(nova, ELECTRONICS_PRODUCTS, nova.tax)
    nova_customers = _make_customers(
        nova,
        [
            ("Liam O'Connor", "liam@example.com", "+263 772 900 111", 40),
            ("Sofia Rossi", "sofia@example.com", "+263 772 900 222", 90),
            ("Grace Adeyemi", "grace@example.com", "+263 772 900 333", 0),
        ],
    )
    db.session.add(
        CustomWorkspace(
            company=nova,
            name="Repairs",
            icon="wrench",
            description="Track device repairs from intake to collection.",
            fields=[
                {"key": "device", "label": "Device", "type": "text", "required": True},
                {"key": "fault", "label": "Reported fault", "type": "textarea"},
                {"key": "status", "label": "Status", "type": "select",
                 "options": ["Intake", "Diagnosing", "Awaiting parts", "Ready", "Collected"]},
                {"key": "estimate", "label": "Estimate", "type": "number"},
                {"key": "due", "label": "Due date", "type": "date"},
            ],
            sort_order=10,
        )
    )
    db.session.add(
        Supplier(company=nova, name="Meridian Distribution", contact_name="Alex Reid",
                 phone="+263 772 500 100", email="orders@meridian.example")
    )

    _generate_sales(
        nova,
        [nova_owner, nova_manager],
        nova_customers,
        nova_products,
        nova.methods,
        days=21,
        per_day=(1, 4),
        seed_value=11,
        location=nova.location,
        register=nova.register,
    )

    _seed_laybys(
        nova, [nova_owner, nova_manager], nova_customers, nova_products, nova.methods,
        plans=[
            (0, [0], 0.30, 45, True),          # Smart TV 55" ? half paid already
            (1, [1, 2], 0.25, 60, False),      # 32" TV + soundbar
        ],
        seed_value=3,
    )
    _seed_laybys(
        aurora, [aurora_owner], aurora_customers, aurora_products, aurora.methods,
        plans=[
            (0, [13, 14], 0.25, 30, True),     # mug + beans gift set
            (1, [15], 0.20, 45, False),        # cold cup
        ],
        seed_value=5,
    )

    db.session.add(
        Announcement(
            title="Scheduled maintenance",
            body="The platform will be read-only on Sunday 02:00–03:00 CAT while we upgrade storage.",
            level="info",
            audience="all",
            created_by=developer.email,
        )
    )

    db.session.commit()

    return {
        "seeded": True,
        "developer": developer.email,
        "companies": [aurora.slug, nova.slug],
        "users": User.query.count(),
        "products": Product.query.count(),
        "sales": Sale.query.count(),
    }
