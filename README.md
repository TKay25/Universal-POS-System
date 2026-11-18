# Universal POS

A multi-tenant, fully customisable cloud POS. Companies compose their own till from a
catalogue of modules, run as many branches and tills as they need, and manage stock,
lay-bys, customers, promotions and reports in one app. A separate developer console
manages every company, user and module on the platform.

## Stack

- **Backend** — Flask 3 + Flask-SQLAlchemy 3. **PostgreSQL** in production (Render), with
  SQLite as the zero-config fallback for local tinkering. Session auth with CSRF,
  role/permission checks, audit trail.
- **Frontend** — dependency-free ES modules that behave like a React app: virtual view
  functions, reactive store, tab manager, hash router, UI kit, responsive SVG charts.
  No build step.

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py            # http://127.0.0.1:5000
```

### Database

Everything persistent (companies, users, stock, sales, lay-bys, audit, custom workspaces)
is stored in one SQLAlchemy URL. Set it once in `.env` (copy `.env.example`):

```
POS_DATABASE_URL=postgresql://user:password@host/database
```

`POS_DATABASE_URL` (or `DATABASE_URL`) wins; without it the app falls back to
`instance/universal_pos.db`. Tables are created on boot and demo data is seeded when
`POS_SEED_DEMO=true` and the database is empty. Delete the SQLite file (or drop the
Postgres tables) to reseed.

#### Connection tuning (`app/dbhelper.py`)

Postgres connections are pooled once per worker and reused. `app/dbhelper.py` exposes the
pool and the fast paths:

| Helper | Use it for |
| --- | --- |
| `fetch_all` / `fetch_one` / `fetch_value` | read-only SQL that does not need ORM objects (each SQL string is compiled once and cached) |
| `insert_rows(Table, rows)` | bulk writes — one `executemany` round trip per 500 rows instead of one per row |
| `session_scope()` | transactions outside a request (scripts, CLI) — commits on success, rolls back on error |
| `retry_transient()` | decorator that retries a call when the socket dropped (deploys, idle timeouts) |
| `warm_pool(2)` | opens connections at boot so the first request skips TLS + auth |
| `pool_status()` / `ping()` | shown by `/healthz` (`/healthz?db=1` also queries the database) |

Pool knobs (all optional): `POS_DB_POOL_SIZE` (5), `POS_DB_MAX_OVERFLOW` (10),
`POS_DB_POOL_TIMEOUT` (30 s), `POS_DB_CONNECT_TIMEOUT` (10 s), `POS_DB_POOL_USE_LIFO`
(`true` — reuses the busiest connection first), `POS_DB_APP_NAME` (`universal-pos`, shows
in `pg_stat_activity`).

## Deploying to Render

1. Push this repository to GitHub and create a **Web Service** on Render (or point Render at
   the included [`render.yaml`](render.yaml) blueprint, which fills in every setting below).
2. **Build command**

   ```
   pip install --upgrade pip && pip install -r requirements.txt
   ```

3. **Start command**

   ```
   gunicorn --workers 3 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT "app:create_app()"
   ```

   The same command lives in [`Procfile`](Procfile) and [`render.yaml`](render.yaml), so a
   blueprint deploy needs no manual configuration.

4. **Python version** — set `PYTHON_VERSION=3.12.8` (or keep [`runtime.txt`](runtime.txt)).
   Prebuilt wheels for `psycopg2-binary` and `reportlab` exist for 3.12; a much newer or
   unpinned interpreter can fall back to a source build that fails and takes the whole
   `pip install` — and therefore gunicorn — down with it.

5. **Environment variables**

   | Key | Value |
   | --- | --- |
   | `POS_DATABASE_URL` | your Render Postgres *Internal* (or External) Database URL |
   | `POS_SECRET_KEY` | a long random string |
   | `POS_SEED_DEMO` | `true` for the demo workspaces, `false` for a clean production start |
   | `POS_COOKIE_SECURE` | `true` (HTTPS only cookies) |
   | `POS_REPORT_CACHE_SECONDS` | how long report payloads/PDFs stay cached (default `60`, `0` disables) |
   | `POS_DB_PRE_PING` | `true` (default) — keep it on for Render Postgres |
   | `POS_DB_POOL_USE_LIFO` | `true` (default) — reuse the hottest pooled connection first |
   | `POS_DB_CONNECT_TIMEOUT` | seconds before a connection attempt fails (default `10`) |

   Leave `POS_DATABASE_URL` unset to fall back to SQLite (not recommended on Render).
   `postgres://`, `postgresql://` and `postgresql+psycopg://` URLs are all normalised to
   `postgresql+psycopg2://` (the driver `requirements.txt` installs) and `sslmode=require` is
   added automatically for remote hosts — so the worker can never boot into a driver that is
   not installed.

   > **Use the Internal Database URL.** The External URL adds a full network round trip to
   > every query — a report with eight aggregates takes seconds instead of milliseconds.
   > For local development against a remote database you can also set
   > `POS_DB_PRE_PING=false` to skip the per-request connection ping.

6. The schema is created and demo data seeded on first boot; the health check is `/healthz`.

### `bash: gunicorn: command not found`

The start command runs *after* a successful build, so this message means the build step
never installed `requirements.txt` — gunicorn is listed there.

1. Open the **Logs → Build** tab and look for the first traceback. The usual culprit is
   `psycopg2-binary` compiling from source (no wheel for the interpreter) — fix it by
   setting `PYTHON_VERSION=3.12.8` and redeploying.
2. Confirm **Build Command** is `pip install -r requirements.txt` and **Root Directory** is
   the repository root.
3. Trigger **Manual Deploy → Clear build cache & deploy** so the environment is rebuilt.

### `ModuleNotFoundError: No module named 'psycopg'`

The worker booted but SQLAlchemy picked the psycopg **3** driver, which is not installed.
`_database_url()` now rewrites any Postgres URL to `postgresql+psycopg2://`, so redeploying
this code fixes it without touching the environment. (If you ever *want* psycopg 3, add
`psycopg[binary]` to `requirements.txt` and remove that normalisation.)


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

- **FIFO costing** — every delivery is stored as a cost layer (quantity + buying price) and
  sales consume the **oldest layers first**. `Sale.cost_cents` is the exact FIFO cost of the
  goods sold, so profit, the summary/report profit columns and insights all reflect what the
  stock actually cost rather than the latest price on file. Voided/refunded goods go back on
  the shelf as a fresh layer at the cost they left at. Stock that pre-dates FIFO gets an
  opening layer at its recorded buying price automatically on boot.
- **Buying price is asked for whenever stock comes in** — Receive stock and the Add side of
  Adjust stock both require it, and the API refuses a receipt without one. Inventory shows
  **Stock value (FIFO)** next to each product.
- **Buying price vs selling price** are tracked separately on every product.
- **Receive stock** supports existing products (updating buying/selling price) and new
  products with SKU, barcode, prices and opening stock. Name suggestions and duplicate
  SKU/barcode guards prevent split records. Each row has **+** (receive) and **−** (remove)
  actions.
- **Bulk tools** (Inventory → Bulk tools) download an Excel-compatible CSV template,
  upload a filled sheet (existing SKUs/barcodes update, new ones are created), and audit a
  stock-count sheet against the system with a preview before applying variances. Imports and
  counts move FIFO layers too.
- **Lay-by** takes stock off the shelf the moment the agreement opens (exactly like a sale),
  puts it back on cancellation, and consumes the FIFO cost when the balance is settled. Each
  agreement **prints or downloads as a branded PDF statement** (items, payments, balance and
  due date).
- **Voids & refunds** restock returned items and are fully audited; receipt lookup finds any
  sale by its number. Receipts are numbered `REC-00001` by default (configurable in
  Settings → Sales & numbering).

## Reports & insights

Dashboard quick insights compute 30-day revenue growth, profit leaders, slow movers,
restock value, lay-by exposure and actionable management tips. The Reports tab ships
sales, products, categories, payments, tax, cashiers, inventory valuation, **low stock**,
stock movements, customers, refunds, cash drawer, lay-bys, branches and suppliers — with
local date ranges and a branch filter.

### PDF and CSV exports

Every report (plus the Summary dashboard) downloads as **PDF** or **CSV**:

- **PDF** — branded A4 document: header band with company/VAT/registration details, a KPI
  strip (net sales, gross profit + margin, cost of goods, average ticket), **up to two
  charts** and zebra tables with totals rows and page numbers. Non-sales reports print the
  table plus a totals row.
- **Summary means summary** — the Summary PDF carries the trend and payment charts and two
  aggregate tables, **sales by branch** and **sales by department** (revenue, cost, profit,
  share). Day-by-day rows live in the Sales report, not here.
- **Profit everywhere** — sales, products sold, categories, cashiers and branches include
  `Cost` and `Profit` columns in both PDF and CSV. Profit = revenue − recorded buying price.
- **Speed** — PDFs are drawn with ReportLab (no browser engine), so 150 rows render in
  ~80 ms once warm. Rendered PDFs and report payloads are cached for `POS_REPORT_CACHE_SECONDS`
  (default 60) so repeat downloads are instant; the `X-Report-Cache` header reports
  `hit`/`miss`.

### Activity log

The **Activity log** (Insights → Activity log, permission `audit.view`) reads the audit trail
and shows *everything* done inside the workspace — sign-ins, sales, refunds and voids, stock
changes, catalog and settings edits, user and role changes, lay-bys, shifts. Filter by free
text, area, person and date range, and click any row to see the recorded values (entity, IP,
metadata). Backed by `GET /api/activity` and `GET /api/activity/facets`.

### Point of sale

A live **Africa/Harare clock** (time + date) sits in the middle of the top bar, between the
screen title and the toolbar actions, so the local time stamped on receipts is always in
view. Department and category filters are **dropdowns** rather than chip rows, which keeps
the catalog area clear no matter how many departments a company runs.

### Workspace ergonomics

- **Collapsible sidebar** — on a PC the sidebar is an icon rail that expands when you hover
  it; the pin button at the right of the top bar keeps it open (or collapses it again), and
  the choice is remembered per browser. Tablets get the same rail with the pin button.
- **Search everywhere** — Products, Sales, Customers, Lay-bys, Departments (departments and
  categories), Inventory (stock levels, movements by product/reference/reason, suppliers),
  Cash drawer (cashier/till), Activity log, Settings and every phone-app list all have a
  search box.
- **Custom date ranges** — every period control also accepts an explicit window: Reports and
  Sales have From/To pickers next to the shortcuts, and the phone app adds a **Custom** chip
  with From/To dates that drives all of its tabs.
- **Adjust stock in tabs** — the adjust-stock dialog separates **Add / remove** (with an
  add/remove direction toggle) from **Set exact** (counted quantity), each with its own
  reason and note. Stock-level rows carry `+` (receive), `−` (remove) and edit actions, and
  the table lists each product's **department** alongside its category.

### Loading feedback

A slim gradient progress bar tracks route changes, long actions show a dimmed busy overlay,
and save/export buttons spin in place. Modal and drawer primary actions spin automatically
until the request finishes or an error appears.

### Phone app

On screens up to 820 px wide the app switches to a phone shell: an app bar with the company
and a live clock, a **period selector pinned above everything** (Today / 7 days / 30 days /
90 days) and five bottom tabs — **Home, Sales, Reports, Stock, Activity**. Every tab follows
the selected period; tabs a role cannot see are hidden.

- **Home** — period sales, profit and margin, the revenue/profit trend, **by branch** and
  **by department** summary tables, payment mix and stock alerts.
- **Sales** — the transaction history for the period with search and *Load more*; tap a
  receipt to open the full sale and **print the receipt**.
- **Reports** — one-tap PDF/CSV downloads for Summary, Sales, Products, Low stock, Inventory
  valuation and Branches, always for the selected period.
- **Stock** — everything at or below its low-stock point, with suggested order quantities.
- **Activity** — the workspace audit feed.
- Powered by `GET /api/reports/mobile` (six targeted queries, cached like the rest of the
  report family).
- **Full app on this device** in the account menu opts out and restores the complete
  workspace for that browser; on the way back, **Phone dashboard** in the topbar account
  menu returns. With the opt-out active on a small screen the sidebar becomes an off-canvas
  drawer behind a hamburger button, so nothing is unreachable.

## Developer console

`/developer` (or the Developer console nav) provides platform overview metrics, company
create/suspend/delete, module overrides, per-user role/password management (including
appointing administrators), announcements, audit log and database maintenance. Platform
staff must *enter* a workspace to act inside it and never inherit tenant admin routes.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

53 tests cover pricing, auth/RBAC, checkout/refund/void, lay-by lifecycle, duplicate
guards, branch attribution, bulk import/count, insights, low-stock and phone-app feeds,
summary/branch/department breakdowns, activity log, movement/shift search, database URL
normalisation, model constructors, PDF exports and developer flows.

## Layout

```
app/
  __init__.py        app factory, CLI, SPA fallback
  dbhelper.py        pooled-connection helpers: raw SQL, bulk inserts, retries, pool stats
  models.py          tenant-scoped data model (typed `Base` declarative class)
  modules.py         module catalogue + config schemas
  defaults.py        permissions, default roles (Administrator, Manager, Cashier, Accountant)
  security.py        CSRF, sessions, RBAC decorators, audit
  services/          pricing, fifo, checkout, laybys, receipt, reports, pdf, cache, timezones, provisioning
  blueprints/        auth, activity, company, catalog, sales, laybys, reports, developer, workspaces
  static/css/app.css design system + app-like layout
  static/js/         core framework + views
  seed.py            demo workspaces
tests/               pytest suite
run.py               dev entry point
```
