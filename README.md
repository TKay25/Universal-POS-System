# Universal POS

A multi-tenant, fully customisable cloud POS. Companies compose their own till from a
catalogue of modules, run as many branches and tills as they need, and manage stock,
lay-bys, customers, promotions and reports in one app. A separate developer console
manages every company, user and module on the platform.

## Stack

- **Backend** — Flask 3 + Flask-SQLAlchemy 3 (SQLite by default), session auth with CSRF,
  role/permission checks, audit trail.
- **Frontend** — dependency-free ES modules that behave like a React app: virtual view
  functions, reactive store, tab manager, hash router, UI kit, SVG charts. No build step.

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py            # http://127.0.0.1:5000
```

The first start creates `instance/universal_pos.db` and seeds two demo workspaces.
Delete that file to reseed from scratch.

### Demo logins

| Role | Email | Password |
| --- | --- | --- |
| Developer (platform) | `developer@universalpos.dev` | `DevAdmin!2024` |
| Administrator — Aurora Coffee Roasters | `owner@aurora.test` | `Owner!2024` |
| Cashier — Aurora Coffee Roasters | `cashier@aurora.test` | `Cashier!2024` |
| Administrator — Nova Home & Tech | `owner@nova.test` | `Owner!2024` |

## What companies can customise

- **Modules** — 26 optional/cored modules (lay-by, departments, bulk stock tools, loyalty,
  tips, service charge, multi-branch, custom workspaces, price overrides, …) each with a
  schema-driven config form in Settings → Modules.
- **Branding & business details** — name, logo text/colour, theme, VAT registration number
  and company registration number (Zimbabwe), receipt templates.
- **Branches & tills** — unlimited branches per company, multiple tills per branch. The POS
  branch switcher records `location_id`/`register_id` on every sale and shift.
- **Departments → categories → products** — e.g. Electronics & Appliances → TVs / Audio /
  Solar; Hardware → Power Tools / DIY / Plumbing / Machinery. Department filters drive the
  till grid.
- **Roles & permissions** — the first user of a company becomes **Administrator**. Admins
  appoint staff, add/remove ordinary users, edit stock and settings. Administrators cannot
  remove other administrators; only platform staff can.
- **Custom fields, promotions, payment methods** (Cash, EcoCash, Bank Transfer, Card by
  default), taxes, receipt designer and custom workspaces.

## Zimbabwe specifics

- All timestamps are stored in UTC and displayed/reported in **Africa/Harare** (CAT, UTC+2).
- Company setup captures company name, logo, **VAT registration number** and **company
  registration number**; both print on receipts when present.
- Receipts carry a Code 128 barcode (pure Python, no native deps).

## Stock, lay-by and bulk tools

- **Buying price vs selling price** are tracked separately on every product.
- **Receive stock** supports existing products (optionally updating buying/selling price)
  and new products with SKU, barcode, prices and opening stock. Name suggestions and
  duplicate SKU/barcode guards prevent split records.
- **Bulk upload** downloads an Excel-compatible CSV template (`Inventory → Templates`) and
  imports products by SKU or barcode. **Stock count** audits a counted sheet against the
  system, previews variances and can apply them.
- **Lay-by** reserves stock on deposit, takes instalments, produces a statement, settles
  into a sale automatically, and restocks on cancellation.
- **Voids & refunds** restock returned items and are fully audited; receipt lookup finds any
  sale by its number.

## Reports & insights

Dashboard quick insights compute 30-day revenue growth, profit leaders, slow movers,
restock value, lay-by exposure and actionable management tips. The Reports tab ships
sales, products, categories, payments, tax, cashiers, inventory valuation, stock movements,
customers, refunds, cash drawer, lay-bys, branches and suppliers — with CSV export, local
date ranges and a branch filter.

## Developer console

`/developer` (or the Developer console nav) provides platform overview metrics, company
create/suspend/delete, module overrides, per-user role/password management (including
appointing administrators), announcements, audit log and database maintenance. Platform
staff must *enter* a workspace to act inside it and never inherit tenant admin routes.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

39 tests cover pricing, auth/RBAC, checkout/refund/void, lay-by lifecycle, duplicate
guards, branch attribution, bulk import/count, insights and developer flows.

## Layout

```
app/
  __init__.py        app factory, CLI, SPA fallback
  models.py          tenant-scoped data model
  modules.py         module catalogue + config schemas
  defaults.py        permissions, default roles (Administrator, Manager, Cashier, Accountant)
  security.py        CSRF, sessions, RBAC decorators, audit
  services/          pricing, checkout, laybys, receipt, reports, timezones, provisioning
  blueprints/        auth, company, catalog, sales, laybys, reports, developer, workspaces
  static/css/app.css design system + app-like layout
  static/js/         core framework + views
  seed.py            demo workspaces
tests/               pytest suite
run.py               dev entry point
```
