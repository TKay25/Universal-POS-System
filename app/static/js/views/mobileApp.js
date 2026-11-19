/* Phone app: period-first dashboard, sales history, report downloads, stock and activity. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, qty, isoDay, addDays, time, date, dateTime, initials } from "../core/fmt.js";
import { get, downloadFile } from "../core/http.js";
import {
  currentCompany, currentUser, hasPerm, moduleOn, isDeveloper, impersonating,
} from "../core/store.js";
import { toggleThemePreference } from "../core/prefs.js";
import {
  button, iconButton, menu, toast, alertBox, loadingBlock, statusBadge, emptyState, searchLoader,
} from "../core/ui.js";
import { areaChart } from "../core/charts.js";
import { busyOverlay, withButtonSpinner } from "../core/loading.js";
import { installApp, isStandalone } from "../core/pwa.js";
import { openSaleDetail } from "./saleDetail.js";

const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 6 },
  { key: "30d", label: "30 days", days: 29 },
  { key: "90d", label: "90 days", days: 89 },
];

const TABS = [
  { key: "home", label: "Home", icon: "home" },
  { key: "sales", label: "Sales", icon: "receipt" },
  { key: "reports", label: "Reports", icon: "chart" },
  { key: "stock", label: "Stock", icon: "layers" },
  { key: "activity", label: "Activity", icon: "list" },
];

function availableTabs() {
  const canSee = {
    home: moduleOn("reports") && hasPerm("reports.view"),
    sales: hasPerm("pos.sell"),
    reports: moduleOn("reports") && hasPerm("reports.view"),
    stock: moduleOn("inventory") && hasPerm("reports.view"),
    activity: hasPerm("audit.view"),
  };
  const tabs = TABS.filter((tab) => canSee[tab.key]);
  // Only selling? then lead with the till, not an empty dashboard.
  return tabs.length ? tabs : TABS.filter((tab) => tab.key === "sales");
}

export default function mobileAppView({ onOpenFullApp, onSignOut, onOpenTill } = {}) {
  const el = h("div", { class: "mapp" });
  const bar = h("header", { class: "mapp__bar" });
  const periodBar = h("div", { class: "mapp__period" });
  const scroll = h("div", { class: "mapp__scroll" });
  const body = h("div", { class: "mapp__body" });
  const tabbar = h("nav", { class: "mapp__tabs" });
  scroll.appendChild(body);
  el.append(bar, periodBar, scroll, tabbar);

  const tabs = availableTabs();
  const state = {
    tab: tabs[0]?.key || "sales",
    period: "30d",
    customFrom: isoDay(addDays(-29)),
    customTo: isoDay(),
    cache: {},
    loading: {},
    token: 0,
    clockTimer: null,
    search: "",
    stockSearch: "",
    activitySearch: "",
  };

  /* Which cached payload each tab paints from (Home and Reports share one). */
  const TAB_DATA = { home: "home", reports: "home", sales: "sales", stock: "stock", activity: "activity" };

  const period = () => PERIODS.find((item) => item.key === state.period) || PERIODS[2];
  const periodLabel = () => (state.period === "custom"
    ? `${date(state.customFrom, { year: false })} → ${date(state.customTo, { year: false })}`
    : period().label);
  const range = () => (state.period === "custom"
    ? { from: state.customFrom, to: state.customTo }
    : { from: isoDay(addDays(-period().days)), to: isoDay() });

  /* ---------- chrome ---------------------------------------------------- */
  function renderBar() {
    clear(bar);
    const company = currentCompany();
    const branding = company?.settings?.branding || {};
    const name = branding.logo_text || company?.name || "Universal POS";
    const clock = h("div", { class: "mapp__clock" });
    const tick = () => { clock.textContent = `${date(new Date(), { year: false })} · ${time(new Date())}`; };
    tick();
    clearInterval(state.clockTimer);
    state.clockTimer = setInterval(tick, 15000);

    const account = iconButton("more", { title: "Account" });
    account.addEventListener("click", () => openAccountMenu(account));

    bar.appendChild(h("div", { class: "mapp__brand" },
      h("div", { class: "mapp__mark" },
        branding.logo_data_url ? h("img", { src: branding.logo_data_url, alt: name }) : initials(name)),
      h("div", { class: "mapp__brandtext" },
        h("div", { class: "mapp__company truncate" }, name),
        clock)));
    bar.appendChild(h("div", { class: "mapp__baractions" }, account));
  }

  function openAccountMenu(anchor) {
    const items = [
      { label: currentUser()?.full_name || "Account", header: true },
      { label: "Switch theme", icon: "palette", onClick: () => toggleThemePreference().catch((error) => toast(error.message, "error")) },
      { label: "Open the till", icon: "cart", onClick: () => onOpenTill?.() },
      { label: "Full app on this device", icon: "grid", onClick: () => onOpenFullApp?.() },
    ];
    if (isDeveloper() && impersonating()) {
      items.push({ label: "Developer console", icon: "shield", onClick: () => onOpenFullApp?.() });
    }
    if (!isStandalone()) {
      items.push({ label: "Install app", icon: "download", onClick: () => installApp() });
    }
    items.push("-");
    items.push({ label: "Sign out", icon: "logout", danger: true, onClick: () => onSignOut?.() });
    menu(anchor, items);
  }

  function renderTabs() {
    clear(tabbar);
    for (const tab of tabs) {
      tabbar.appendChild(h("button", {
        class: `mapp__tab${state.tab === tab.key ? " is-active" : ""}`,
        type: "button",
        onClick: () => switchTab(tab.key),
      }, icon(tab.icon), h("span", {}, tab.label)));
    }
  }

  function renderPeriod() {
    clear(periodBar);
    for (const item of PERIODS) {
      periodBar.appendChild(h("button", {
        class: `mapp__periodbtn${item.key === state.period ? " is-active" : ""}`,
        type: "button",
        onClick: () => setPeriod(item.key),
      }, item.label));
    }
    periodBar.appendChild(h("button", {
      class: `mapp__periodbtn${state.period === "custom" ? " is-active" : ""}`,
      type: "button",
      onClick: () => setPeriod("custom"),
    }, icon("calendar"), "Custom"));

    if (state.period !== "custom") return;
    const from = h("input", { class: "input input--sm", type: "date", value: state.customFrom, max: state.customTo });
    const to = h("input", { class: "input input--sm", type: "date", value: state.customTo, min: state.customFrom });
    from.addEventListener("change", () => {
      if (!from.value) return;
      state.customFrom = from.value;
      if (state.customTo < state.customFrom) {
        state.customTo = from.value;
        to.value = from.value;
      }
      from.max = state.customTo;
      applyRangeChange();
    });
    to.addEventListener("change", () => {
      if (!to.value) return;
      state.customTo = to.value;
      if (state.customTo < state.customFrom) {
        state.customFrom = to.value;
        from.value = to.value;
      }
      to.min = state.customFrom;
      applyRangeChange();
    });
    periodBar.appendChild(h("div", { class: "mapp__custom" },
      h("span", { class: "report-toolbar__label" }, "From"), from,
      h("span", { class: "report-toolbar__label" }, "To"), to));
  }

  function switchTab(key) {
    if (state.tab === key) {
      scroll.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    state.tab = key;
    renderTabs();
    scroll.scrollTop = 0;
    renderBody();
  }

  function setPeriod(key) {
    if (state.period === key) return;
    state.period = key;
    applyRangeChange();
    renderPeriod();
  }

  function applyRangeChange() {
    state.cache = {};
    state.token += 1;
    state.loading = {};
    renderBody();
  }

  /* ---------- data ------------------------------------------------------ */
  async function load(key, fetcher, { silent = false } = {}) {
    if (state.loading[key]) return;
    state.loading[key] = true;
    const token = state.token;
    if (!silent) {
      clear(body);
      body.appendChild(h("div", { class: "mapp__loading" }, loadingBlock("Loading", { compact: true })));
    }
    try {
      const value = await fetcher();
      if (token !== state.token) return;
      state.cache[key] = value;
      if (TAB_DATA[state.tab] === key) renderBody();
    } catch (error) {
      if (token !== state.token || TAB_DATA[state.tab] !== key) return;
      clear(body);
      if (error.status === 401 || error.status === 403) {
        body.appendChild(h("section", { class: "mcard" },
          h("div", { class: "mcard__title" }, "Not available for your role"),
          h("p", { class: "mcard__note" }, error.message || "You do not have access to this."),
          button("Open the full app", { variant: "primary", icon: "grid", onClick: () => onOpenFullApp?.() })));
      } else {
        body.appendChild(h("div", { class: "mapp__error" }, alertBox(error.message, "danger"),
          button("Try again", { variant: "primary", icon: "refresh", onClick: () => { state.cache[key] = null; renderBody(); } })));
      }
    } finally {
      state.loading[key] = false;
    }
  }

  function renderBody() {
    clear(body);
    if (state.tab === "home") return renderHome();
    if (state.tab === "sales") return renderSales();
    if (state.tab === "reports") return renderReports();
    if (state.tab === "stock") return renderStock();
    if (state.tab === "activity") return renderActivity();
    return undefined;
  }

  /* ---------- home ------------------------------------------------------ */
  function renderHome() {
    const data = state.cache.home;
    if (!data) {
      load("home", () => get("/reports/mobile", range()));
      return;
    }
    const cards = data.cards || {};
    const salesCents = Number(cards.sales_cents || 0);
    const profitCents = Number(cards.profit_cents || 0);
    const margin = salesCents ? (profitCents / salesCents) * 100 : 0;

    body.appendChild(h("section", { class: "mcard mhero" },
      h("div", { class: "mhero__label" },
        `Sales · ${state.period === "custom" ? periodLabel() : periodLabel().toLowerCase()}`),
      h("div", { class: "mhero__value" }, money(salesCents)),
      h("div", { class: "mhero__meta" },
        h("span", { class: `mchip ${profitCents >= 0 ? "is-good" : "is-bad"}` },
          icon("trend"), money(profitCents), " profit"),
        h("span", { class: "mchip" }, icon("percent"), `${margin.toFixed(1)}% margin`),
        h("span", { class: "mchip" }, icon("receipt"), `${number(cards.transactions)} sales`),
        h("span", { class: "mchip" }, icon("cash"), `${money(cards.average_ticket_cents)} avg`))));

    const series = data.series || [];
    if (series.length > 1) {
      body.appendChild(section("Revenue and profit", null, areaChart({
        series: [
          { name: "Revenue", color: "var(--primary)", values: series.map((row) => (row.sales_cents || 0) / 100) },
          { name: "Profit", color: "#10b981", values: series.map((row) => (row.profit_cents || 0) / 100) },
        ],
        labels: series.map((row) => date(row.date, { year: false })),
        height: 150,
        formatValue: (value) => money(Math.round(value * 100)),
      }), h("div", { class: "mlegend" },
        h("span", {}, h("i", { style: { background: "var(--primary)" } }), "Revenue"),
        h("span", {}, h("i", { style: { background: "#10b981" } }), "Profit"))));
    }

    const branches = data.branches || [];
    if (branches.length) {
      body.appendChild(section("By branch", `${branches.length} branch${branches.length === 1 ? "" : "es"}`,
        h("div", { class: "mtable" },
          h("div", { class: "mtable__head" },
            h("span", {}, "Branch"), h("span", { class: "num" }, "Sales"),
            h("span", { class: "num" }, "Profit"), h("span", { class: "num" }, "Share")),
          branches.map((row) => h("div", { class: "mtable__row" },
            h("span", { class: "truncate" }, row.name),
            h("span", { class: "num" }, money(row.sales_cents)),
            h("span", { class: "num" }, money(row.profit_cents)),
            h("span", { class: "num dim" },
              `${salesCents ? Math.round((row.sales_cents / salesCents) * 100) : 0}%`))))));
    }

    const departments = data.departments || [];
    if (departments.length) {
      const top = departments.slice(0, 10);
      body.appendChild(section("By department", `${departments.length} departments`,
        h("div", { class: "mtable" },
          h("div", { class: "mtable__head" },
            h("span", {}, "Department"), h("span", { class: "num" }, "Revenue"),
            h("span", { class: "num" }, "Profit"), h("span", { class: "num" }, "Share")),
          top.map((row) => h("div", { class: "mtable__row" },
            h("span", { class: "truncate" },
              h("i", { class: "mdot", style: { background: row.color || "var(--primary)" } }), row.name),
            h("span", { class: "num" }, money(row.revenue_cents)),
            h("span", { class: "num" }, money(row.profit_cents)),
            h("span", { class: "num dim" },
              `${salesCents ? Math.round((row.revenue_cents / salesCents) * 100) : 0}%`))))));
    }

    const mixes = data.payment_mix || [];
    if (mixes.length) {
      body.appendChild(section("Payment mix", null, h("div", { class: "mrows" }, mixes.slice(0, 6).map((row) =>
        h("div", { class: "mrow" },
          h("span", { class: "truncate" }, row.name),
          h("span", { class: "num strong" }, money(row.amount_cents)))))));
    }

    const stock = data.stock || {};
    if (stock.alerts) {
      body.appendChild(h("section", { class: "mcard mstock" },
        h("div", { class: "mcard__head" },
          h("div", { class: "mcard__title" }, "Stock alerts"),
          h("span", { class: "mbadge is-warn" }, `${number(stock.low_count)} low · ${number(stock.out_count)} out`)),
        h("div", { class: "mrows" }, (stock.items || []).slice(0, 4).map((item) =>
          h("div", { class: "mrow" },
            h("span", { class: "truncate" }, item.name),
            h("span", { class: `mbadge ${Number(item.stock) <= 0 ? "is-bad" : "is-warn"}` },
              Number(item.stock) <= 0 ? "Out" : qty(item.stock))))),
        hasPerm("reports.view")
          ? button("See all stock alerts", { size: "sm", variant: "soft", block: true, onClick: () => switchTab("stock") })
          : null));
    }
  }

  /* ---------- sales ----------------------------------------------------- */
  function renderSales() {
    const data = state.cache.sales;
    if (!data) {
      load("sales", () => get("/sales", { ...range(), per_page: 25, q: state.search || undefined }));
      return;
    }
    const search = searchLoader(h("input", {
      class: "input",
      placeholder: "Search receipt or customer…",
      value: state.search,
    }));
    search.addEventListener("input", () => {
      state.search = search.value.trim();
      clearTimeout(search._timer);
      search._timer = setTimeout(() => {
        state.cache.sales = null;
        renderBody();
      }, 260);
    });

    const items = data.items || [];
    body.appendChild(h("section", { class: "mcard" },
      h("div", { class: "mcard__head" },
        h("div", { class: "mcard__title" }, "Transactions"),
        h("span", { class: "mcard__hint" }, periodLabel())),
      search,
      items.length
        ? h("div", { class: "mlist" }, items.map((sale) => h("button", {
          class: "mlist__row",
          type: "button",
          onClick: () => openSaleDetail(sale.id),
        },
        h("div", { class: "grow", style: { minWidth: 0 } },
          h("div", { class: "mlist__title truncate" }, sale.number),
          h("div", { class: "mlist__meta truncate" },
            `${dateTime(sale.created_at)} · ${sale.cashier || "—"}`)),
        h("div", { class: "mlist__right" },
          h("span", { class: "mlist__amount num" }, money(sale.total_cents)),
          statusBadge(sale.status)))))
        : emptyState({ icon: "receipt", title: "No sales in this period", text: "Try a wider date range." }),
      data.meta && data.meta.pages > data.meta.page
        ? button(`Load more (${data.meta.total - items.length} left)`, {
          size: "sm", variant: "soft", block: true, icon: "chevronDown",
          onClick: () => loadMoreSales(),
        })
        : null));
  }

  async function loadMoreSales() {
    const current = state.cache.sales;
    const nextPage = (current.meta.page || 1) + 1;
    const overlay = busyOverlay("Loading more…");
    try {
      const data = await get("/sales", { ...range(), per_page: 25, page: nextPage, q: state.search || undefined });
      state.cache.sales = { items: [...current.items, ...data.items], meta: data.meta };
      renderBody();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      overlay.close();
    }
  }

  /* ---------- reports --------------------------------------------------- */
  function renderReports() {
    const data = state.cache.home;
    if (!data) {
      load("home", () => get("/reports/mobile", range()));
      return;
    }
    const canExport = hasPerm("reports.export");
    const downloads = data.downloads || [];

    body.appendChild(h("section", { class: "mcard" },
      h("div", { class: "mcard__head" },
        h("div", { class: "mcard__title" }, "Download reports"),
        h("span", { class: "mcard__hint" }, periodLabel())),
      button("Download summary PDF", {
        variant: "primary", icon: "download", block: true, disabled: !canExport,
        onClick: (event) => runDownload("summary", "pdf", event.currentTarget, "Summary"),
      }),
      h("div", { class: "mdownloads" }, downloads.map((item) => downloadRow(item, canExport))),
      canExport ? null : h("div", { class: "mcard__note" }, "Ask an administrator for export rights to download.")));
  }

  function downloadRow(item, canExport) {
    return h("div", { class: "mdownloads__row" },
      h("div", { class: "grow", style: { minWidth: 0 } },
        h("div", { class: "mlist__title truncate" }, item.name),
        h("div", { class: "mlist__meta truncate" }, item.description)),
      h("div", { class: "mdownloads__actions" },
        button("PDF", {
          size: "sm", variant: "soft", disabled: !canExport,
          onClick: (event) => runDownload(item.key, "pdf", event.currentTarget, item.name),
        }),
        button("CSV", {
          size: "sm", variant: "ghost", disabled: !canExport,
          onClick: (event) => runDownload(item.key, "csv", event.currentTarget, item.name),
        })));
  }

  async function runDownload(key, format, trigger, label) {
    const overlay = busyOverlay(`Preparing ${label}…`);
    try {
      await withButtonSpinner(trigger, () => downloadFile(`/reports/${key}.${format}`, range()));
      toast(`${label} ${format.toUpperCase()} downloaded.`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      overlay.close();
    }
  }

  /* ---------- stock ----------------------------------------------------- */
  function renderStock() {
    const data = state.cache.stock;
    if (!data) {
      load("stock", () => get("/reports/low_stock", range()));
      return;
    }
    const all = data.rows || [];
    const term = state.stockSearch.toLowerCase();
    const rows = term
      ? all.filter((row) => `${row[0]} ${row[1]} ${row[2]}`.toLowerCase().includes(term))
      : all;
    const out = all.filter((row) => Number(row[3]) <= 0).length;
    const canExport = hasPerm("reports.export");

    const search = searchLoader(h("input", { class: "input", placeholder: "Search product, SKU or department…", value: state.stockSearch }));
    search.addEventListener("input", () => {
      state.stockSearch = search.value.trim();
      clearTimeout(search._timer);
      search._timer = setTimeout(renderBody, 200);
    });

    body.appendChild(h("section", { class: "mcard" },
      h("div", { class: "mcard__head" },
        h("div", { class: "mcard__title" }, "Low stock"),
        h("span", { class: `mbadge ${all.length ? "is-warn" : "is-good"}` },
          all.length ? `${all.length} to reorder · ${out} out` : "All good")),
      search,
      h("div", { class: "mdownloads__actions mt-3 mb-3" },
        button("PDF", { size: "sm", variant: "soft", disabled: !canExport,
          onClick: (event) => runDownload("low_stock", "pdf", event.currentTarget, "Low stock") }),
        button("CSV", { size: "sm", variant: "ghost", disabled: !canExport,
          onClick: (event) => runDownload("low_stock", "csv", event.currentTarget, "Low stock") })),
      rows.length
        ? h("div", { class: "mlist" }, rows.map((row) => h("div", { class: "mlist__row" },
          h("div", { class: "grow", style: { minWidth: 0 } },
            h("div", { class: "mlist__title truncate" }, row[0]),
            h("div", { class: "mlist__meta truncate" }, `${row[2]} · order ${number(row[5])} · value ${money(row[6])}`)),
          h("span", { class: `mbadge ${Number(row[3]) <= 0 ? "is-bad" : "is-warn"}` },
            Number(row[3]) <= 0 ? "Out" : qty(row[3])))))
        : h("div", { class: "mcard__note" },
          state.stockSearch
            ? `No stock alerts match “${state.stockSearch}”.`
            : "Nothing is at or below its low-stock point.")));
  }

  /* ---------- activity -------------------------------------------------- */
  function renderActivity() {
    const data = state.cache.activity;
    if (!data) {
      load("activity", () => get("/activity", { ...range(), per_page: 30, q: state.activitySearch || undefined }));
      return;
    }
    const items = data.items || [];
    const search = searchLoader(h("input", {
      class: "input",
      placeholder: "Search action, detail or person…",
      value: state.activitySearch,
    }));
    search.addEventListener("input", () => {
      state.activitySearch = search.value.trim();
      clearTimeout(search._timer);
      search._timer = setTimeout(() => {
        state.cache.activity = null;
        renderBody();
      }, 280);
    });
    body.appendChild(h("section", { class: "mcard" },
      h("div", { class: "mcard__head" },
        h("div", { class: "mcard__title" }, "Activity log"),
        h("span", { class: "mcard__hint" }, periodLabel())),
      search,
      items.length
        ? h("div", { class: "mfeed" }, items.map((entry) => h("div", { class: "mfeed__row" },
          h("div", { class: "mfeed__dot" }),
          h("div", { class: "grow", style: { minWidth: 0 } },
            h("div", { class: "mfeed__title truncate" }, humanise(entry.action)),
            h("div", { class: "mfeed__meta truncate" }, entry.summary || entry.entity || "—"),
            h("div", { class: "mfeed__who truncate" },
              `${entry.actor} · ${dateTime(entry.created_at)}`)))))
        : emptyState({
          icon: state.activitySearch ? "search" : "list",
          title: state.activitySearch ? "Nothing matched" : "No activity yet",
          text: state.activitySearch
            ? `No activity matches “${state.activitySearch}”.`
            : "Actions show up here as they happen.",
        }),
      data.meta && data.meta.pages > data.meta.page
        ? button(`Load more (${data.meta.total - items.length} left)`, {
          size: "sm", variant: "soft", block: true, icon: "chevronDown",
          onClick: () => loadMoreActivity(),
        })
        : null));
  }

  async function loadMoreActivity() {
    const current = state.cache.activity;
    const nextPage = (current.meta.page || 1) + 1;
    const overlay = busyOverlay("Loading more…");
    try {
      const data = await get("/activity", {
        ...range(), per_page: 30, page: nextPage, q: state.activitySearch || undefined,
      });
      state.cache.activity = { items: [...current.items, ...data.items], meta: data.meta };
      renderBody();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      overlay.close();
    }
  }

  /* ---------- helpers --------------------------------------------------- */
  function section(title, hint, ...children) {
    return h("section", { class: "mcard" },
      h("div", { class: "mcard__head" },
        h("div", { class: "mcard__title" }, title),
        hint ? h("span", { class: "mcard__hint" }, hint) : null),
      ...children);
  }

  renderBar();
  renderPeriod();
  renderTabs();
  renderBody();

  return {
    el,
    destroy() {
      clearInterval(state.clockTimer);
    },
  };
}

function humanise(action = "") {
  const text = String(action).replace(/[._]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Activity";
}
