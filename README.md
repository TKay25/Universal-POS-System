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
`POS_SEED_DEMO=true` and the database is empty. Columns added after the first release are
applied automatically too — `app/schema.py` inspects each table and runs an idempotent
`ALTER TABLE … ADD COLUMN` for anything missing (for example `categories.icon` and
`users.must_change_password`), so existing Postgres databases upgrade themselves on the next
boot. Delete the SQLite file (or drop the Postgres tables) to reseed.

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

## Daily executive summary (WhatsApp)

Every company can have any number of **report recipients**. Recipients are **teammates**: a
report can only go to someone already on the team, whose **WhatsApp number is captured when
they are added** (Settings → Team) and reused for the 6pm summary. Each recipient receives a
WhatsApp executive summary at **18:00 company time**. It covers today vs
yesterday and the same weekday last week, week-to-date vs last week and the best week
this year, month-to-date vs last month and the best month, year-to-date vs last year,
top 3 products for today, this week and this month, a lowest-3 watchlist, payment mix,
branch performance, **sales and profit for every team member today**, and management
advice. Numbers are never typed twice: subscribing a teammate in
**Settings → Report recipients** simply picks them from the team list.

WhatsApp Cloud API credentials live only in the server environment:

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | The WhatsApp **phone number ID** from Meta (not the display number) |
| `WHATSAPP_ACCESS_TOKEN` | Permanent Cloud API access token |
| `WHATSAPP_BUSINESS_NUMBER` | Display number, e.g. `+263 77 123 4567` (optional) |
| `WHATSAPP_API_VERSION` | Graph API version, default `v23.0` |
| `WHATSAPP_TEMPLATE_NAME` | Optional approved template whose body is a single `{{1}}` variable; used when the 24h customer window is closed |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Template language code, default `en` |
| `POS_DAILY_REPORT_SCHEDULER` | `true` to run the in-process 6pm dispatcher (set in `render.yaml`) |
| `POS_DAILY_REPORT_HOUR` | Local send hour, default `18` |
| `POS_WHATSAPP_DRY_RUN` | `true` logs instead of sending — useful locally |

The shorter aliases `WA_ID`, `WA_NUMBER` and `WA_TOKEN` are also accepted. Meta requires
an approved message template for business-initiated messages sent outside a 24-hour
customer-service window; if your account is in that situation, add the approved template
in Meta Business Manager before the first 6pm run.

The dispatcher is idempotent: `report_dispatches` is unique per company/day, so multiple
gunicorn workers cannot send twice. Failed recipients are retried on the next check
without resending to people who already received the report. You can also trigger it
manually:

```powershell
flask --app "app:create_app()" send-executive-reports --dry-run --force
flask --app "app:create_app()" send-executive-reports --force
```

On Render, set the three WhatsApp values on the web service. If the scheduler is disabled,
run the `--force` command from a Render cron job instead.

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

Seeded only when `POS_SEED_DEMO=1` (the default for local runs). The sign-in screen no longer
lists them — use this table instead.

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
  and company registration number (Zimbabwe), receipt templates. **Company logo** upload
  lives at the top of Settings → General (and in Branding): one image, published immediately
  and used by the sidebar, the phone app bar, receipts, PDF exports and the reports header.
  The label above the nav,
  the phone app bar, receipts and the window title all use the **workspace name** until you
  type your own wordmark in Branding (`logo_text_custom`), so renaming the workspace never
  leaves the old name on screen — and a wordmark you *did* type is never overwritten.
- **Branches & tills** — unlimited branches per company, multiple tills per branch. The POS
  branch switcher records `location_id`/`register_id` on every sale and shift. The topbar
  switcher is global: choose one branch for selling, or **All branches** for a combined,
  read-only view of the dashboard, sales, reports and cash-drawer history. POS always
  requires a concrete branch — it never sells into the aggregate.
- **Departments → categories → products** — e.g. Electronics & Appliances → TVs / Audio /
  Solar; Hardware → Power Tools / DIY / Plumbing / Machinery. Department filters drive the
  till grid. Any product can be re-filed from the row menu (**Move to department /
  category**) without touching its prices, stock or sales history.
- **Categories own the tile look** — a category carries an icon and colour, set when you
  create or edit it (from Inventory → Categories or Departments → Add category). Products in
  that category inherit both, so the product form only shows a one-line tile preview with a
  **Change tile** disclosure for the rare product that needs its own look. Re-filing a product
  into another category re-skins it automatically, restyling a category re-skins the products
  that still wear its old tile (custom tiles are left alone), and categories created before
  icons existed are backfilled from the icons their products already use.
- **Roles & permissions** — the first user of a company becomes **Administrator**. Admins
  appoint staff, add/remove ordinary users, edit stock and settings. Administrators cannot
  remove other administrators; only platform staff can.
- **Inviting a teammate** — Settings → Team → *Add teammate* asks for name, email,
  **WhatsApp number** and role (the number feeds the 6pm executive summary) and can be
  edited later. Emails are unique across the whole platform, so inviting an address that
  already has an account (in this workspace or another) is refused with a clear message
  instead of creating a second login. The API generates a short, unambiguous **temporary password**
  (`Up-…`) and shows it once with a copy button; the teammate signs in with it and must
  choose their own password before the workspace opens. *Reset password* re-issues a
  temporary password the same way, and any password an admin sets is treated as temporary
  too. The new column is added on boot by `app/schema.py`.
- **Custom fields, promotions, payment methods** (Cash, EcoCash, Bank Transfer, Card by
  default), taxes, receipt designer and custom workspaces.

## Zimbabwe specifics

- All timestamps are stored in UTC and displayed/reported in **Africa/Harare** (CAT, UTC+2).
- **VAT 15.5% is the default rate.** Every new workspace is provisioned with a `VAT 15.5%`
  tax rate marked as the default, the "New tax rate" form pre-fills 15.5%, and new products
  start on that rate (existing products and imports keep whatever rate they already have).
  Settings → General shows the live default next to the VAT registration number.
- **Self-service signup** asks for company name, your name, work email, password and
  WhatsApp, plus a **"Is this email the company email too?"** Yes/No toggle (default **No**).
  *No* keeps the sign-in address private — company contact email and the receipt email start
  blank and are filled in later under Settings → General; *Yes* uses the same address for
  both. Company setup also captures the **VAT registration number** and **company
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
  Change stock both require it, and the API refuses a receipt without one. Inventory shows
  **Stock value (FIFO)** next to each product.
- **Where the money came from** — every purchase also records its **funding source**:
  *profits from sales* or *external funds* (owner capital, a loan, an investor). Inventory's
  **Stock funding** card shows the split, the amount behind each source and the latest
  purchases, so a manager can see how much of the shelf the business funded itself.
- **Buying price vs selling price** are tracked separately on every product.
- **Inventory is the catalog** — the Products tab folded into Inventory: the Stock levels
  table carries **Edit**, **Add stock**, **Remove stock** and a **More** menu (move to another
  department/category, print label, duplicate, archive, delete), and the page header carries
  **Add product**, **Categories** and **Export**. Old `#/products` links land on Inventory.
- **Receive stock** adds a delivery to a product you already sell (updating buying/selling
  price); **Create a product** next door handles brand-new items, and its name field lists
  matching products as you type so you can add stock to an existing record instead of
  duplicating it. Duplicate SKU/barcode guards back this up on the API.
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

Dashboard quick insights compute revenue growth, top 3 products, lowest-3 watchlist,
profit leaders, slow movers, restock value, branch performance, busiest hour, lay-by
exposure and a broad list of management actions. The cockpit tiles are laid out as a
measured masonry — each card is placed into the shortest column, so wide screens show
three tight columns with no dead cells, and the layout re-flows when the window or sidebar
changes width. The KPI strip leads with sales today, transactions and **gross profit**
(with margin and average sale in the footnote), so profit — not ticket size — is always in
view. The Reports tab ships sales, products,
categories, payments, tax, cashiers, inventory valuation, **low stock**, stock movements,
customers, refunds, cash drawer, lay-bys, branches and suppliers — with local date ranges,
the global branch filter and a **user filter** that starts on *All users* and can be
narrowed to one cashier. The summary shows **sales and profit by user** alongside the
branch and department splits. Reports open on **Today** by default and show a comparison
band: selected period vs the previous equivalent period, plus the best and worst day,
week, month, quarter or year for that range. Sales has the same user filter (All users /
Only me / a specific person), and the 6pm executive summary includes a *by team member*
section for the day.

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

Product tiles are **colour-coded by stock**: green while the shelf is healthy, amber at or
below the product's reorder point, red (and unclickable) when it is out. **Held orders** are
always one click away — from the toolbar, the cart header, or the empty cart — and the drawer
shows each parked cart's lines and value so it can be resumed and charged later.

### Workspace ergonomics

- **Collapsible sidebar** — on a PC the sidebar collapses to a 74px icon rail; hovering the
  rail expands it over the content (so nothing shifts), and the pin button in the top bar
  keeps it open or collapses it again. The choice is remembered per account and per browser.
  Tablets get the same pin, the expanded width narrows to 196px below 900px so tables still
  fit, and in the full app on a phone the sidebar becomes an off-canvas drawer with a
  backdrop behind the hamburger button.
- **Search everywhere** — Sales, Customers, Lay-bys, Departments (departments and
  categories), Inventory (stock levels, movements by product/reference/reason, suppliers),
  Cash drawer (cashier/till), Activity log, Settings and every phone-app list all have a
  search box. Typing shows an inline spinner in the box until the results land.
- **Custom date ranges** — every period control also accepts an explicit window: Reports and
  Sales have From/To pickers next to the shortcuts, and the phone app adds a **Custom** chip
  with From/To dates that drives all of its tabs. Every screen — dashboard cockpit, reports,
  sales, phone app — opens on **Today**, and the dashboard adds a *Management period* chip
  row (Today / 7 / 30 / 90 days) for widening the secondary panels without leaving the page.
- **Change stock in three separate tabs** — **Add stock** (quantity, buying price, funding
  source, note), **Remove stock** (quantity, reason such as wastage or returns, note) and
  **Set exact** (counted quantity, buying price and funding only when the count adds units).
  There is no shared add/remove toggle: each tab asks only for what it needs. Stock-level rows
  carry `+` (add), `−` (remove), edit and a **More** menu, and the category cell lists the
  product's **department** underneath its category.
- **Responsive by design** — the shell is a sidebar + tab workspace down to 820px and a
  dedicated phone app (Home / Sales / Reports / Stock / Activity) below that. Wide tables drop
  their lowest-priority columns on tablets (department, low-at, cost and stock value fold into
  the product and category cells) and keep the row actions pinned to the right edge, so
  nothing important ever scrolls out of reach. The expanded sidebar narrows itself under
  900px so tables still fit. Product-name suggestions, tile previews and the three stock tabs
  all reflow to a single column on a phone.

### Loading feedback

A slim gradient progress bar tracks route changes, long actions show a dimmed busy overlay,
and save/export buttons spin in place. Modal and drawer primary actions spin automatically
until the request finishes or an error appears.

### Look and feel

The shell sits on one calm ambient backdrop (`--bg-glow` plus a faint `--pattern-ink` dot
grid in `app.css`) shared by the sign-in screen, the desktop shell, the phone shell and the
boot splash: three soft colour washes in the brand palette, a 22 px dot grid, and — on the
sign-in art panel — a masked blueprint grid with a slow drifting glow. Everything else is
painted on opaque surfaces, so contrast and dark mode are unaffected; the tiled layer drops
out under `prefers-reduced-data`, and the drift stops under `prefers-reduced-motion`.

Type and spacing are driven by two knobs: every `font-size` in `app.css` is
`calc(var(--type-scale, 1) * …)` and every `padding`/`margin`/`gap` is
`calc(var(--space-scale, 1) * …)`. Both are **.9** from 821 px up (desktop and tablet) and
**1** on the phone shell — so density can be tuned in one place. Sizes supplied inline from
JS go through the same scale via the `.fs` utility (`style: { "--fs": "16px" }`).

### Phone app

On screens up to 820 px wide the app switches to a phone shell: an app bar with the company
and a live clock, a **period selector pinned above everything** (Today / 7 days / 30 days /
90 days) and five bottom tabs — **Home, Sales, Reports, Stock, Activity**. Every tab follows
the selected period and always opens on **Today**; tabs a role cannot see are hidden.

- **Home** — period sales, profit and margin, then a **management summary card** right above
  the chart: one headline comparing the period with the one before it plus two short actions
  (margin, restocking, branch or department focus). Below it: the revenue/profit trend,
  **by branch** and **by department** summary tables, payment mix and stock alerts.
- **Sales** — the transaction history for the period with search and *Load more*; tap a
  receipt to open the full sale and **print the receipt**.
- **Reports** — one-tap PDF/CSV downloads for Summary, Sales, Products, Low stock, Inventory
  valuation and Branches, always for the selected period.
- **Stock** — what the shelves are worth today (**at cost**, **expected sales** at retail and the
  **expected profit** between them, with the potential margin and product count), then
  everything at or below its low-stock point with suggested order quantities.
- **Activity** — the workspace audit feed.
- Powered by `GET /api/reports/mobile` (six targeted queries, cached like the rest of the
  report family). The payload carries `advice` (tone, headline and up to two action lines)
  computed from the previous-period comparison, margin, stock alerts and branch spread.
- **Full app on this device** in the account menu opts out and restores the complete
  workspace for that browser; on the way back, **Phone dashboard** in the topbar account
  menu returns. With the opt-out active on a small screen the sidebar becomes an off-canvas
  drawer behind a hamburger button, so nothing is unreachable.

## Installable app (PWA)

Universal POS is a progressive web app: install it from the browser and it gets its own
icon, a full-screen window and a cached shell that opens without a connection.

- **Manifest** — `/manifest.webmanifest` declares `display: standalone`, `start_url` and
  scope `/`, brand `theme_color`/`background_color`, 192/512 icons (plain and maskable)
  and shortcuts for the till, sales and reports. Served from the site root so the worker
  keeps root scope.
- **Service worker** — `/sw.js` (`app/static/sw.js`, served with
  `Service-Worker-Allowed: /` and `Cache-Control: no-cache`, so a release reaches clients
  immediately). It precaches the shell and then uses network-first with a cache fallback,
  which keeps development free of stale assets while the app still opens offline.
- **Tenant data is never cached** — every `/api/` request bypasses the worker, so sales,
  tickets and customer records only ever come from the server. Losing the connection shows
  the offline panel with **Try again** (and an automatic retry on `online`) instead of a
  browser error page.
- **One-click install** — the account menu (desktop and phone shells) and the sign-in card
  offer **Install app**, and only when the browser has actually handed over its
  `beforeinstallprompt` event: one click runs the native flow, no steps to follow. Installed
  windows open on the **sign-in screen** every launch (the browser session may still be
  live, but an installed app starts at login like any other terminal app); a refresh inside
  the same window keeps the session. iOS is the one platform that has no programmatic
  install, so there the single line *Tap Share → Add to Home Screen* is shown instead of a
  step list.
- **Branding follows the theme** — `<meta name="theme-color">` is rewritten on every theme
  or branding change so the installed window's title bar matches the app surface.
- Icons live in `app/static/icons/` (`icon-192`, `icon-512`, `icon-maskable-*`,
  `apple-touch-icon.png`, `favicon-32.png`); `apple-touch-icon` and the Apple meta tags
  cover iOS home-screen installs.
- Requires HTTPS in production (Render terminates TLS) or `localhost`/`127.0.0.1` locally,
  which browsers treat as secure contexts.

## Developer console

`/developer` (or the Developer console nav) provides platform overview metrics, company
create/suspend/delete, module overrides, per-user role/password management (including
appointing administrators), announcements, audit log and database maintenance. Platform
staff must *enter* a workspace to act inside it and never inherit tenant admin routes.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

68 tests cover pricing, auth/RBAC, checkout/refund/void, lay-by lifecycle, duplicate
guards, branch attribution, bulk import/count, insights, low-stock and phone-app feeds,
summary/branch/department breakdowns, activity log, movement/shift search, database URL
normalisation, model constructors, PDF exports, developer flows and the installable-app
endpoints (manifest contents, icon sizes, worker headers, offline shell).

## Layout

```
app/
  __init__.py        app factory, CLI, SPA fallback
  pwa.py             manifest, service worker and offline-shell routes
  dbhelper.py        pooled-connection helpers: raw SQL, bulk inserts, retries, pool stats
  models.py          tenant-scoped data model (typed `Base` declarative class)
  modules.py         module catalogue + config schemas
  defaults.py        permissions, default roles (Administrator, Manager, Cashier, Accountant)
  security.py        CSRF, sessions, RBAC decorators, audit
  services/          pricing, fifo, checkout, laybys, receipt, reports, pdf, cache, timezones, provisioning
  blueprints/        auth, activity, company, catalog, sales, laybys, reports, developer, workspaces
  templates/         index.html shell + offline.html
  static/css/app.css design system + app-like layout
  static/js/         core framework (incl. core/pwa.js) + views
  static/manifest.webmanifest, static/sw.js, static/icons/   installable-app assets
  seed.py            demo workspaces
tests/               pytest suite
run.py               dev entry point
```
