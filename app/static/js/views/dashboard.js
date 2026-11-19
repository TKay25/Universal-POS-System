/* Dashboard: KPI cards, trend, mixes and recent activity. */

import { h, clear } from "../core/dom.js";
import { icon, productIcon } from "../core/icons.js";
import { money, number, date, isoDay, addDays, rangeFromPreset } from "../core/fmt.js";
import { get, post } from "../core/http.js";
import { settings, preferences, hasPerm, moduleOn, currentUser, companyName } from "../core/store.js";
import {
  pageHeader, statCard, sectionCard, button, table, statusBadge, badge, toast, loadingBlock,
  emptyState, alertBox, moneyText, avatar,
} from "../core/ui.js";
import { areaChart, donutChart, barList, legend, heatStrip } from "../core/charts.js";
import { openSaleDetail } from "./saleDetail.js";

const PALETTE = ["#5b5bd6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316"];

export default async function dashboardView(ctx) {
  const el = h("div");
  el.appendChild(loadingBlock("Loading dashboard"));

  let today;
  let overview;
  let onboarding = null;
  let insights = null;
  let loadedAt = 0;

  async function load() {
    const range = rangeFromPreset("30d", 29);
    const canReport = hasPerm("reports.view");
    const [dashboardData, overviewData] = await Promise.all([
      get("/reports/dashboard"),
      canReport ? get("/reports/overview", range).catch(() => null) : Promise.resolve(null),
    ]);
    today = dashboardData;
    overview = overviewData || {};
    // Paint the numbers that matter first; the secondary panels arrive after.
    render();
    loadedAt = Date.now();

    const secondary = [];
    if (canReport) {
      secondary.push(get("/reports/insights").then((data) => { insights = data; }).catch(() => null));
    }
    if (hasPerm("settings.manage")) {
      secondary.push(get("/company/onboarding").then((data) => { onboarding = data; }).catch(() => null));
    }
    if (!secondary.length) return;
    await Promise.all(secondary);
    const scroller = el.closest(".view");
    const scrollTop = scroller?.scrollTop || 0;
    render();
    if (scroller) scroller.scrollTop = scrollTop;
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  function render() {
    clear(el);
    const user = currentUser();
    const personalWidgets = preferences().dashboard_widgets;
    const widgets = new Set(
      Array.isArray(personalWidgets) ? personalWidgets : settings()?.dashboard?.widgets || [
        "sales_today", "transactions_today", "average_ticket", "low_stock",
        "sales_chart", "payment_mix", "top_products", "recent_sales",
      ],
    );

    el.appendChild(pageHeader({
      title: `${greeting()}, ${user.full_name.split(" ")[0]}`,
      subtitle: `${companyName()} · ${date(new Date(), { year: true })}`,
      actions: [
        button("Reports", { icon: "chart", onClick: () => ctx.navigate("/reports") }),
        hasPerm("pos.sell")
          ? button("New sale", { variant: "primary", icon: "plus", onClick: () => ctx.navigate("/pos") })
          : null,
      ],
    }));

    if (onboarding && !onboarding.dismissed && onboarding.completed < onboarding.total) {
      el.appendChild(renderOnboarding(onboarding));
    }

    for (const announcement of today.announcements || []) {
      el.appendChild(h("div", { class: "banner-stack" }, alertBox(announcement.title, announcement.level === "critical" ? "danger" : announcement.level === "warning" ? "warning" : "info")));
    }

    const cards = today.cards || {};
    const kpis = [];
    if (widgets.has("sales_today")) {
      kpis.push(statCard({
        label: "Sales today", value: money(cards.sales_cents), icon: "cash",
        foot: `${number(cards.transactions)} transactions`, tone: "",
      }));
    }
    if (widgets.has("transactions_today")) {
      kpis.push(statCard({
        label: "Transactions", value: number(cards.transactions), icon: "receipt",
        foot: `${number(cards.items_sold, 1)} items sold`, tone: "accent",
      }));
    }
    if (widgets.has("average_ticket")) {
      kpis.push(statCard({
        label: "Average ticket", value: money(cards.average_ticket_cents), icon: "trend",
        foot: `Gross profit ${money(cards.gross_profit_cents)}`, tone: "success",
      }));
    }
    if (widgets.has("low_stock")) {
      kpis.push(statCard({
        label: "Low stock", value: number((today.low_stock || []).length), icon: "layers",
        foot: (today.low_stock || []).length ? "Needs attention" : "Everything stocked",
        tone: (today.low_stock || []).length ? "warning" : "success",
        onClick: moduleOn("inventory") ? () => ctx.navigate("/inventory") : null,
      }));
    }
    if (kpis.length) el.appendChild(h("div", { class: "grid grid--kpi mb-4" }, kpis));

    if (insights) el.appendChild(renderInsights(insights));

    const grid = h("div", { class: "grid grid--dash" });

    if (widgets.has("sales_chart")) {
      const series = overview.series || [];
      grid.appendChild(h("div", { class: "span-8" }, sectionCard({
        title: "Sales trend",
        subtitle: "Last 30 days",
        actions: badge("Gross " + money((overview.cards || {}).sales_cents), "primary"),
        body: series.length
          ? areaChart({
            points: series.map((row) => row.sales_cents / 100),
            labels: series.map((row) => date(row.date, { year: false })),
            height: 260,
            formatValue: (value) => money(Math.round(value * 100)),
          })
          : emptyState({ icon: "chart", title: "No sales yet", text: "Your trend appears as soon as you take the first sale." }),
      })));
    }

    if (widgets.has("payment_mix")) {
      const mixes = (overview.payment_mix || []).slice(0, 6);
      grid.appendChild(h("div", { class: "span-4" }, sectionCard({
        title: "Payment mix",
        subtitle: "Last 30 days",
        body: mixes.length
          ? h("div", { class: "col items-center gap-3" },
            donutChart({
              segments: mixes.map((row, index) => ({ label: row.name, value: row.amount_cents, color: PALETTE[index % PALETTE.length] })),
              size: 170,
            }),
            legend(mixes.map((row, index) => ({
              label: row.name,
              color: PALETTE[index % PALETTE.length],
              value: money(row.amount_cents),
            }))))
          : emptyState({ icon: "card", title: "No payments yet" }),
      })));
    }

    if (widgets.has("top_products")) {
      grid.appendChild(h("div", { class: "span-4" }, sectionCard({
        title: "Top products",
        subtitle: "By quantity sold",
        body: barList({
          rows: (overview.top_products || []).map((row) => ({ label: row.name, value: row.qty })),
          formatValue: (value) => `${number(value, 0)} sold`,
        }),
      })));
    }

    if (widgets.has("category_mix")) {
      grid.appendChild(h("div", { class: "span-4" }, sectionCard({
        title: "Category mix",
        subtitle: "Revenue contribution",
        body: barList({
          rows: (overview.category_mix || []).map((row) => ({ label: row.name, value: row.revenue_cents, color: row.color })),
        }),
      })));
    }

    if (widgets.has("hourly_heat")) {
      grid.appendChild(h("div", { class: "span-4" }, sectionCard({
        title: "Busiest hours",
        subtitle: "Transactions by hour",
        body: h("div", { class: "col gap-3" },
          heatStrip((overview.hourly || []).map((row) => row.transactions)),
          h("div", { class: "flex justify-between tiny dim" }, h("span", {}, "00:00"), h("span", {}, "12:00"), h("span", {}, "23:00"))),
      })));
    }

    if (widgets.has("recent_sales")) {
      const recent = today.recent_sales || [];
      grid.appendChild(h("div", { class: "span-8" }, sectionCard({
        title: "Recent sales",
        subtitle: "Latest tickets across the workspace",
        flush: true,
        actions: button("View all", { size: "sm", variant: "ghost", onClick: () => ctx.navigate("/sales") }),
        body: recent.length
          ? table({
            compact: true,
            rows: recent,
            onRowClick: (row) => openSaleDetail(row.id, { onChanged: () => ensureLoaded({ force: true }) }),
            columns: [
              { key: "number", label: "Receipt", render: (row) => h("div", {}, h("div", { class: "strong mono" }, row.number), h("div", { class: "tiny dim" }, row.cashier)) },
              { key: "customer", label: "Customer", render: (row) => row.customer || "Walk-in" },
              { key: "created_at", label: "When", render: (row) => h("span", { class: "dim" }, date(row.created_at)) },
              { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
              { key: "total_cents", label: "Total", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.total_cents)) },
            ],
          })
          : emptyState({ icon: "receipt", title: "No sales yet", text: "Open the till and take your first sale." }),
      })));
    }

    if ((today.low_stock || []).length) {
      grid.appendChild(h("div", { class: "span-4" }, sectionCard({
        title: "Needs restocking",
        subtitle: "At or below threshold",
        body: h("div", { class: "list", style: { margin: "-10px -16px" } },
          today.low_stock.slice(0, 6).map((product) => h("div", { class: "list__row" },
            h("div", { class: "module-card__icon product-icon" }, productIcon(product.icon)),
            h("div", { class: "grow", style: { minWidth: 0 } },
              h("div", { class: "truncate strong small" }, product.name),
              h("div", { class: "tiny dim" }, product.sku || "No SKU")),
            badge(`${number(product.stock_qty, 0)} left`, product.stock_qty <= 0 ? "danger" : "warning"))),
          moduleOn("inventory")
            ? h("div", { style: { padding: "10px 16px" } }, button("Manage inventory", { size: "sm", variant: "soft", block: true, onClick: () => ctx.navigate("/inventory") }))
            : null),
      })));
    }

    el.appendChild(grid);
  }

  function renderInsights(data) {
    const growth = data.revenue.growth_percent;
    const wrap = h("div", { class: "grid grid--3 mb-4" });

    const card = (title, subtitle, body) => sectionCard({ title, subtitle, body });

    wrap.appendChild(card("Revenue boost", "Last 30 days vs previous 30", h("div", { class: "col gap-3" },
      h("div", { class: "flex items-end justify-between" },
        h("div", { class: "kpi__value", style: { fontSize: "22px" } }, money(data.revenue.last_30_cents)),
        growth == null
          ? badge("New", "info")
          : badge(`${growth > 0 ? "+" : ""}${growth}%`, growth >= 0 ? "success" : "danger")),
      h("div", { class: "tiny dim" }, `Previous period ${money(data.revenue.previous_30_cents)}`),
      h("div", { class: "progress" }, h("div", { class: "progress__bar", style: { width: `${Math.min(100, Math.max(4, (data.revenue.last_30_cents / Math.max(1, Math.max(data.revenue.last_30_cents, data.revenue.previous_30_cents))) * 100))}%` } })),
      h("div", { class: "flex justify-between small" },
        h("span", {}, `Today ${money(data.revenue.today_cents)}`),
        h("span", { class: "dim" }, `Yesterday ${money(data.revenue.yesterday_cents)}`)))));

    wrap.appendChild(card("Profit leaders", "Revenue minus buying price (30 days)", barList({
      rows: (data.profit_leaders || []).map((row) => ({ label: row.name, value: row.profit_cents })),
    })));

    wrap.appendChild(card("Needs attention", "Slow movers and restock needs", h("div", { class: "col gap-2" },
      (data.slow_movers || []).slice(0, 3).map((row) => h("div", { class: "flex items-center gap-2" },
        h("div", { class: "grow", style: { minWidth: 0 } },
          h("div", { class: "truncate small strong" }, row.name),
          h("div", { class: "tiny dim" }, `${number(row.stock_qty, 0)} on hand`)),
        badge(money(row.stock_value_cents), "warning"))),
      !data.slow_movers?.length ? h("div", { class: "small dim" }, "Everything is moving - nice.") : null,
      data.layby && data.layby.active
        ? h("div", { class: "flex justify-between small" }, h("span", {}, "Lay-by outstanding"), h("span", { class: "num strong" }, money(data.layby.outstanding_cents)))
        : null)));

    const tipsCard = card("Management actions", `Busiest hour ${data.busiest_hour != null ? `${String(data.busiest_hour).padStart(2, "0")}:00` : "-"} / ${data.repeat_customers_30d} repeat customers`,
      h("div", { class: "col gap-2" },
        (data.tips || []).map((tip) => h("button", {
          class: `alert alert--${tip.tone}`,
          type: "button",
          style: { textAlign: "left", cursor: "pointer" },
          onClick: () => ctx.navigate(tip.route),
        }, icon(tip.tone === "success" ? "check" : tip.tone === "danger" ? "warn" : "info"),
        h("span", { class: "grow" },
          h("span", { class: "strong" }, tip.title),
          h("span", { class: "small" }, ` · ${tip.detail}`)))),
        h("div", { class: "flex gap-2 mt-1" },
          button("Open reports", { size: "sm", icon: "chart", onClick: () => ctx.navigate("/reports") }),
          button("Manage stock", { size: "sm", variant: "ghost", icon: "layers", onClick: () => ctx.navigate("/inventory") }))));
    wrap.appendChild(tipsCard);
    return h("div", {}, h("div", { class: "flex items-center gap-2 mb-2" },
      h("div", { class: "settings-card__title" }, "Quick insights"),
      badge("For management", "primary"),
      h("span", { class: "tiny dim" }, `As of ${data.local_today}`)),
    wrap);
  }

  function renderOnboarding(data) {
    const card = h("div", { class: "card mb-4", style: { padding: "18px" } });
    card.appendChild(h("div", { class: "flex items-start gap-4 wrap" },
      h("div", { class: "grow", style: { minWidth: "260px" } },
        h("div", { class: "flex items-center gap-2" },
          h("div", { class: "module-card__icon" }, icon("sparkles")),
          h("div", { class: "settings-card__title" }, "Make this workspace yours"),
          badge(`${data.percent}% ready`, data.percent >= 100 ? "success" : "primary")),
        h("div", { class: "settings-card__sub" }, "A few steps and your POS is ready for customers."),
        h("div", { class: "progress mt-3", style: { maxWidth: "420px" } },
          h("div", { class: "progress__bar", style: { width: `${data.percent}%` } }))),
      button("Dismiss", {
        variant: "ghost",
        size: "sm",
        onClick: async () => {
          try {
            await post("/company/onboarding/dismiss");
            card.remove();
          } catch { /* ignore */ }
        },
      })));
    const steps = h("div", { class: "onboarding mt-3" });
    for (const step of data.steps) {
      steps.appendChild(h("div", {
        class: `onboarding__step${step.done ? " is-done" : ""}`,
        onClick: () => ctx.navigate(step.route.replace("#", "")),
      },
      h("span", { class: "onboarding__check" }, icon("check")),
      h("span", { class: "onboarding__label grow" }, step.label),
      h("span", { class: "tiny dim" }, step.hint),
      icon("chevronRight")));
    }
    card.appendChild(steps);
    return card;
  }

  ctx.tab?.setTitle?.("Dashboard");

  let inFlight = null;
  function ensureLoaded({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && loadedAt && Date.now() - loadedAt < 60_000) return Promise.resolve();
    inFlight = load()
      .catch((error) => {
        clear(el);
        el.appendChild(alertBox(error.message, "danger"));
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  ensureLoaded();
  return { el, onActivate: () => { ensureLoaded(); } };
}
