/* Reports: summary analytics plus every tabular report. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, percent, date, isoDay, addDays, dateTime } from "../core/fmt.js";
import { get, downloadFile } from "../core/http.js";
import { hasPerm, moduleConfig } from "../core/store.js";
import {
  pageHeader, sectionCard, button, table, badge, alertBox, statCard, emptyState, toast, segmented,
  field, textInput,
} from "../core/ui.js";
import { areaChart, donutChart, barList, legend, heatStrip } from "../core/charts.js";

const PALETTE = ["#5b5bd6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316"];

export default async function reportsView(ctx) {
  const el = h("div");
  const defaultDays = Number(moduleConfig("reports").default_range_days || 30);
  const state = { key: "summary", from: isoDay(addDays(-(defaultDays - 1))), to: isoDay() };
  let registry = [];

  const content = h("div");
  const tabsHost = h("div", { class: "chips mb-4" });
  const fromInput = h("input", { class: "input input--sm", type: "date", value: state.from, style: { width: "150px" } });
  const toInput = h("input", { class: "input input--sm", type: "date", value: state.to, style: { width: "150px" } });

  function applyRange() {
    state.from = fromInput.value || state.from;
    state.to = toInput.value || state.to;
    load();
  }
  fromInput.addEventListener("change", applyRange);
  toInput.addEventListener("change", applyRange);

  const presets = h("div", { class: "chips" },
    ...[["Today", 0], ["7 days", 6], ["30 days", 29], ["90 days", 89], ["Year", 364]].map(([label, days]) =>
      h("button", { class: "chip", type: "button", onClick: () => {
        state.from = isoDay(addDays(-days));
        state.to = isoDay();
        fromInput.value = state.from;
        toInput.value = state.to;
        load();
      } }, label)));

  el.appendChild(pageHeader({
    title: "Reports",
    subtitle: "Numbers you can reconcile and file",
    actions: [
      button("Export CSV", { icon: "download", onClick: exportCurrent }),
      button("Refresh", { icon: "refresh", variant: "ghost", onClick: load }),
    ],
  }));

  el.appendChild(h("div", { class: "flex gap-2 items-center wrap mb-4" },
    presets,
    h("div", { class: "flex gap-2 items-center", style: { marginLeft: "auto" } },
      h("span", { class: "tiny dim" }, "From"), fromInput,
      h("span", { class: "tiny dim" }, "To"), toInput)));
  el.appendChild(tabsHost);
  el.appendChild(content);

  function renderTabs() {
    clear(tabsHost);
    const entries = [{ key: "summary", name: "Summary", icon: "trend" }, ...registry.map((report) => ({ ...report, icon: "chart" }))];
    for (const entry of entries) {
      tabsHost.appendChild(h("button", {
        class: `chip${state.key === entry.key ? " is-active" : ""}`,
        type: "button",
        title: entry.description || entry.name,
        onClick: () => { state.key = entry.key; renderTabs(); load(); },
      }, icon(entry.icon), entry.name));
    }
  }

  async function load() {
    clear(content);
    content.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      if (!registry.length) {
        const catalog = await get("/reports/catalog");
        registry = catalog.reports;
        renderTabs();
      }
      if (state.key === "summary") await renderSummary();
      else await renderTable(state.key);
    } catch (error) {
      clear(content);
      content.appendChild(alertBox(error.message, "danger"));
    }
  }

  async function renderSummary() {
    const data = await get("/reports/overview", { from: state.from, to: state.to });
    clear(content);
    const cards = data.cards || {};
    content.appendChild(h("div", { class: "grid grid--kpi mb-4" },
      statCard({ label: "Net sales", value: money(cards.sales_cents), icon: "cash", foot: `${number(cards.transactions)} transactions` }),
      statCard({ label: "Average ticket", value: money(cards.average_ticket_cents), icon: "trend", foot: `${number(cards.items_sold, 1)} items sold`, tone: "accent" }),
      statCard({ label: "Gross profit", value: money(cards.gross_profit_cents), icon: "chart", foot: `Cost ${money(cards.cost_cents)}`, tone: "success" }),
      statCard({ label: "Tax collected", value: money(cards.tax_cents), icon: "percent", foot: `${money(cards.discount_cents)} discounts · ${money(cards.refunded_cents)} refunds`, tone: "warning" })));

    const grid = h("div", { class: "grid grid--dash" });
    grid.appendChild(h("div", { class: "span-8" }, sectionCard({
      title: "Sales trend",
      subtitle: `${date(state.from)} → ${date(state.to)}`,
      body: areaChart({
        points: (data.series || []).map((row) => row.sales_cents / 100),
        labels: (data.series || []).map((row) => date(row.date, { year: false })),
        height: 280,
        formatValue: (value) => money(Math.round(value * 100)),
      }),
    })));
    const mixes = data.payment_mix || [];
    grid.appendChild(h("div", { class: "span-4" }, sectionCard({
      title: "Payment mix",
      body: h("div", { class: "col items-center gap-3" },
        donutChart({ segments: mixes.map((row, index) => ({ label: row.name, value: row.amount_cents, color: PALETTE[index % PALETTE.length] })), size: 170 }),
        legend(mixes.map((row, index) => ({ label: row.name, color: PALETTE[index % PALETTE.length], value: money(row.amount_cents) })))),
    })));
    grid.appendChild(h("div", { class: "span-4" }, sectionCard({
      title: "Top products",
      body: barList({ rows: (data.top_products || []).map((row) => ({ label: row.name, value: row.qty })), formatValue: (v) => `${number(v)} sold` }),
    })));
    grid.appendChild(h("div", { class: "span-4" }, sectionCard({
      title: "Categories",
      body: barList({ rows: (data.category_mix || []).map((row) => ({ label: row.name, value: row.revenue_cents, color: row.color })) }),
    })));
    grid.appendChild(h("div", { class: "span-4" }, sectionCard({
      title: "Busiest hours",
      body: h("div", { class: "col gap-3" },
        heatStrip((data.hourly || []).map((row) => row.transactions)),
        h("div", { class: "flex justify-between tiny dim" }, h("span", {}, "00:00"), h("span", {}, "12:00"), h("span", {}, "23:00"))),
    })));
    content.appendChild(grid);
  }

  async function renderTable(key) {
    const data = await get(`/reports/${key}`, { from: state.from, to: state.to });
    clear(content);
    const report = registry.find((entry) => entry.key === key);
    const columns = data.columns.map((column) => ({
      key: column.key,
      label: column.label,
      align: ["money", "number", "percent"].includes(column.type) ? "right" : "",
      render: (row, index) => formatCell(row[column.key], column.type),
    }));
    content.appendChild(sectionCard({
      title: data.name,
      subtitle: `${data.description} · ${data.rows.length} rows`,
      flush: true,
      actions: button("Export CSV", { size: "sm", icon: "download", onClick: exportCurrent }),
      body: table({
        rows: data.rows.map((row) => {
          const object = {};
          data.columns.forEach((column, index) => { object[column.key] = row[index]; });
          return object;
        }),
        columns,
        empty: { icon: "chart", title: "Nothing in this period", text: "Try a wider date range." },
      }),
    }));
  }

  function formatCell(value, type) {
    if (value === null || value === undefined || value === "") return h("span", { class: "dim" }, "—");
    if (type === "money") return h("span", { class: "num" }, money(value));
    if (type === "number") return h("span", { class: "num" }, number(value, 0));
    if (type === "percent") return h("span", { class: "num" }, percent(value, 0));
    if (type === "bool") return value ? badge("Yes", "success") : badge("No");
    if (type === "badge") {
      const tone = value === "completed" ? "success" : value === "refunded" || value === "voided" ? "danger" : value === "partially_refunded" ? "warning" : "";
      return badge(String(value).replace(/_/g, " "), tone);
    }
    return String(value);
  }

  async function exportCurrent() {
    if (!hasPerm("reports.export")) {
      toast("You need the export permission.", "warning");
      return;
    }
    try {
      const key = state.key === "summary" ? "sales" : state.key;
      await downloadFile(`/reports/${key}.csv`, { from: state.from, to: state.to });
      toast("Report exported.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  load();
  return { el };
}
