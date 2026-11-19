/* Reports: summary analytics plus every tabular report. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, percent, date, isoDay, addDays, dateTime } from "../core/fmt.js";
import { get, downloadFile } from "../core/http.js";
import { hasPerm } from "../core/store.js";
import { branchQuery, branchScope } from "../core/branch.js";
import {
  pageHeader, sectionCard, button, table, badge, alertBox, statCard, emptyState, toast, segmented,
  skeletonCards, select,
} from "../core/ui.js";
import { areaChart, donutChart, barList, legend, heatStrip } from "../core/charts.js";
import { withButtonSpinner, busyOverlay } from "../core/loading.js";

const PALETTE = ["#5b5bd6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316"];

const REPORT_ICONS = {
  summary: "trend",
  sales: "receipt",
  products: "box",
  categories: "tag",
  payments: "card",
  tax: "percent",
  cashiers: "users",
  inventory: "layers",
  low_stock: "warn",
  stock_movements: "refresh",
  customers: "users",
  refunds: "rotate",
  shifts: "clock",
  laybys: "calendar",
  branches: "map",
  suppliers: "truck",
};

export default async function reportsView(ctx) {
  const el = h("div");
  const state = { key: "summary", from: isoDay(), to: isoDay(), userId: "" };
  let activePreset = 0;
  let registry = [];
  let team = [];

  const content = h("div");
  const comparisonHost = h("div", { class: "mb-4" });
  const tabsHost = h("div", { class: "chips mb-4" });
  const fromInput = h("input", { class: "input input--sm", type: "date", value: state.from, style: { width: "150px" } });
  const toInput = h("input", { class: "input input--sm", type: "date", value: state.to, style: { width: "150px" } });
  const userSelect = select({
    value: "",
    options: [{ value: "", label: "All users" }],
    onChange: (event) => {
      state.userId = event.target.value;
      load();
    },
  });

  function userQuery() {
    return state.userId ? { user_id: state.userId } : {};
  }

  function userLabel() {
    if (!state.userId) return "All users";
    return team.find((row) => String(row.id) === String(state.userId))?.name || "Selected user";
  }

  async function loadTeam() {
    try {
      const data = await get("/reports/team");
      team = data.items || [];
      clear(userSelect);
      userSelect.appendChild(h("option", { value: "" }, "All users"));
      for (const member of team) {
        userSelect.appendChild(h("option", {
          value: String(member.id),
          selected: String(state.userId) === String(member.id),
        }, member.role ? `${member.name} · ${member.role}` : member.name));
      }
    } catch { /* keep All users only */ }
  }

  function applyRange() {
    state.from = fromInput.value || state.from;
    state.to = toInput.value || state.to;
    activePreset = null;
    renderPresets();
    load();
  }
  fromInput.addEventListener("change", applyRange);
  toInput.addEventListener("change", applyRange);

  const presetHost = h("div", { class: "chips" });
  const PRESETS = [["Today", 0], ["7 days", 6], ["30 days", 29], ["90 days", 89], ["Year", 364]];
  function renderPresets() {
    clear(presetHost);
    for (const [label, days] of PRESETS) {
      presetHost.appendChild(h("button", {
        class: `chip${activePreset === days ? " is-active" : ""}`,
        type: "button",
        onClick: () => {
          activePreset = days;
          state.from = isoDay(addDays(-days));
          state.to = isoDay();
          fromInput.value = state.from;
          toInput.value = state.to;
          renderPresets();
          load();
        },
      }, label));
    }
  }
  renderPresets();

  el.appendChild(pageHeader({
    title: "Reports",
    subtitle: `${branchScope().label} · numbers you can reconcile and file`,    actions: [
      button("PDF", { icon: "download", variant: "primary", onClick: (event) => exportPdf(event.currentTarget) }),
      button("CSV", { icon: "download", onClick: (event) => exportCurrent(event.currentTarget) }),
      button("Refresh", { icon: "refresh", variant: "ghost", onClick: (event) => withButtonSpinner(event.currentTarget, load) }),
    ],
  }));

  el.appendChild(h("div", { class: "report-toolbar" },
    h("div", { class: "report-toolbar__group" }, presetHost),
    h("div", { class: "report-toolbar__group report-toolbar__group--end" },
      h("span", { class: "report-toolbar__label" }, "User"),
      h("div", { style: { width: "190px" } }, userSelect),
      h("span", { class: "report-toolbar__label" }, "From"), fromInput,
      h("span", { class: "report-toolbar__label" }, "To"), toInput)));
  tabsHost.className = "report-tabs";
  el.appendChild(tabsHost);
  el.appendChild(comparisonHost);
  el.appendChild(content);

  function renderTabs() {
    clear(tabsHost);
    const entries = [{ key: "summary", name: "Summary" }, ...registry.map((report) => ({ ...report }))];
    for (const entry of entries) {
      tabsHost.appendChild(h("button", {
        class: `report-tab${state.key === entry.key ? " is-active" : ""}`,
        type: "button",
        title: entry.description || entry.name,
        onClick: () => { state.key = entry.key; renderTabs(); load(); },
      }, icon(REPORT_ICONS[entry.key] || "chart"), h("span", {}, entry.name)));
    }
  }

  async function load() {
    clear(content);
    content.appendChild(skeletonCards({ label: "Loading report" }));
    const comparisonPromise = loadComparison();
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
    await comparisonPromise;
  }

  async function loadComparison() {
    try {
      const data = await get("/reports/comparison", {
        from: state.from, to: state.to, ...branchQuery(), ...userQuery(),
      });
      renderComparison(data);
    } catch {
      clear(comparisonHost);
    }
  }

  function renderComparison(data) {
    clear(comparisonHost);
    const current = data.current || {};
    const previous = data.previous || {};
    const change = previous.change_percent;
    const tone = change == null ? "info" : change >= 0 ? "success" : "danger";
    const unit = data.unit_label || "period";
    const best = data.best;
    const worst = data.worst;

    const gapText = (row) => {
      if (!row || row.vs_current_percent == null) return "No benchmark yet";
      const gap = row.vs_current_percent;
      if (gap >= 0) return `Current is ${Math.abs(gap)}% ahead`;
      return `Current is ${Math.abs(gap)}% behind`;
    };

    comparisonHost.appendChild(h("div", { class: "flex items-center gap-2 mb-2 wrap" },
      h("div", { class: "settings-card__title" }, "Period comparison"),
      badge(`${current.transactions || 0} transactions`, "info"),
      state.userId ? badge(userLabel(), "primary") : null,
      h("span", { class: "tiny dim" }, `${date(state.from)} → ${date(state.to)} · compared by ${unit}`)));
    comparisonHost.appendChild(h("div", { class: "grid grid--kpi" },
      statCard({
        label: "Selected period",
        value: money(current.revenue_cents),
        icon: "cash",
        foot: `${money(current.profit_cents)} profit`,
        tone: "accent",
      }),
      statCard({
        label: `vs ${previous.label || "previous"}`,
        value: change == null ? "—" : `${change > 0 ? "+" : ""}${change}%`,
        icon: "trend",
        foot: `${money(previous.revenue_cents)} previously`,
        tone,
      }),
      statCard({
        label: `Best ${unit}`,
        value: best ? money(best.revenue_cents) : "—",
        icon: "chart",
        foot: best ? `${best.label} · ${gapText(best)}` : "Not enough history yet",
        tone: "success",
      }),
      statCard({
        label: `Worst ${unit}`,
        value: worst ? money(worst.revenue_cents) : "—",
        icon: "warn",
        foot: worst ? `${worst.label} · ${gapText(worst)}` : "Not enough history yet",
        tone: "warning",
      })));
  }

  async function renderSummary() {
    const params = { from: state.from, to: state.to, lists: 0, ...branchQuery(), ...userQuery() };
    const data = await get("/reports/overview", params);
    clear(content);
    const cards = data.cards || {};
    const salesCents = Number(cards.sales_cents || 0);
    const profitCents = Number(cards.gross_profit_cents || 0);
    const margin = salesCents ? (profitCents / salesCents) * 100 : 0;
    content.appendChild(h("div", { class: "grid grid--kpi mb-4" },
      statCard({ label: "Net sales", value: money(cards.sales_cents), icon: "cash", foot: `${number(cards.transactions)} transactions` }),
      statCard({ label: "Average ticket", value: money(cards.average_ticket_cents), icon: "trend", foot: `${number(cards.items_sold, 1)} items sold`, tone: "accent" }),
      statCard({ label: "Gross profit", value: money(cards.gross_profit_cents), icon: "chart", foot: `${margin.toFixed(1)}% margin · cost ${money(cards.cost_cents)}`, tone: profitCents >= 0 ? "success" : "danger" }),
      statCard({ label: "Tax collected", value: money(cards.tax_cents), icon: "percent", foot: `${money(cards.discount_cents)} discounts · ${money(cards.refunded_cents)} refunds`, tone: "warning" })));

    const series = data.series || [];
    const grid = h("div", { class: "grid grid--dash" });
    grid.appendChild(h("div", { class: "span-8" }, sectionCard({
      title: "Revenue and profit",
      subtitle: `${date(state.from)} → ${date(state.to)}`,
      actions: legend([
        { label: "Revenue", color: PALETTE[0] },
        { label: "Profit", color: PALETTE[3] },
      ]),
      body: areaChart({
        series: [
          { name: "Revenue", color: PALETTE[0], values: series.map((row) => (row.sales_cents || 0) / 100) },
          { name: "Profit", color: PALETTE[3], values: series.map((row) => (row.profit_cents || 0) / 100) },
        ],
        labels: series.map((row) => date(row.date, { year: false })),
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
    const branches = data.branches || [];
    if (branches.length) {
      const top = Math.max(...branches.map((row) => row.sales_cents), 1);
      grid.appendChild(h("div", { class: "span-6" }, sectionCard({
        title: "By branch",
        subtitle: `${branches.length} branch${branches.length === 1 ? "" : "es"} in this period`,
        flush: true,
        body: table({
          rows: branches,
          columns: [
            { key: "name", label: "Branch", render: (row) => h("div", {},
              h("div", { class: "strong" }, row.name),
              h("div", { class: "tiny dim" }, `${number(row.transactions)} sales`)) },
            {
              key: "share",
              label: "Share",
              render: (row) => h("div", { class: "flex items-center gap-2" },
                h("div", { class: "bar-row__track grow", style: { height: "6px" } },
                  h("div", { class: "bar-row__fill", style: { width: `${Math.max(3, Math.round((row.sales_cents / top) * 100))}%` } })),
                h("span", { class: "tiny dim num" }, `${Math.round((row.sales_cents / Math.max(1, cards.sales_cents)) * 100)}%`)),
            },
            { key: "sales_cents", label: "Revenue", align: "right", render: (row) => h("span", { class: "num strong" }, money(row.sales_cents)) },
            { key: "profit_cents", label: "Profit", align: "right", render: (row) => h("span", { class: "num" }, money(row.profit_cents)) },
          ],
        }),
      })));
    }

    const team = data.team || [];
    if (team.length) {
      const top = Math.max(...team.map((row) => row.sales_cents), 1);
      grid.appendChild(h("div", { class: "span-6" }, sectionCard({
        title: "By user",
        subtitle: `${team.length} user${team.length === 1 ? "" : "s"} took money in this period`,
        flush: true,
        body: table({
          rows: team,
          columns: [
            { key: "name", label: "User", render: (row) => h("div", {},
              h("div", { class: "strong" }, row.name),
              h("div", { class: "tiny dim" }, `${number(row.transactions)} sales · avg ${money(row.average_ticket_cents)}`)) },
            {
              key: "share",
              label: "Share",
              render: (row) => h("div", { class: "flex items-center gap-2" },
                h("div", { class: "bar-row__track grow", style: { height: "6px" } },
                  h("div", { class: "bar-row__fill", style: { width: `${Math.max(3, Math.round((row.sales_cents / top) * 100))}%` } })),
                h("span", { class: "tiny dim num" }, `${row.share_percent}%`)),
            },
            { key: "sales_cents", label: "Sales", align: "right", render: (row) => h("span", { class: "num strong" }, money(row.sales_cents)) },
            { key: "profit_cents", label: "Profit", align: "right", render: (row) => h("span", { class: "num" }, money(row.profit_cents)) },
          ],
        }),
      })));
    }

    const departments = data.department_mix || [];
    if (departments.length) {
      const top = Math.max(...departments.map((row) => row.revenue_cents), 1);
      grid.appendChild(h("div", { class: "span-6" }, sectionCard({
        title: "By department",
        subtitle: `${departments.length} department${departments.length === 1 ? "" : "s"} in this period`,
        flush: true,
        body: table({
          rows: departments,
          columns: [
            { key: "name", label: "Department", render: (row) => h("div", { class: "flex items-center gap-2" },
              h("span", { class: "chip__dot", style: { background: row.color || "var(--primary)" } }),
              h("div", {},
                h("div", { class: "strong" }, row.name),
                h("div", { class: "tiny dim" }, `${number(row.qty)} units`))) },
            {
              key: "share",
              label: "Share",
              render: (row) => h("div", { class: "flex items-center gap-2" },
                h("div", { class: "bar-row__track grow", style: { height: "6px" } },
                  h("div", { class: "bar-row__fill", style: { width: `${Math.max(3, Math.round((row.revenue_cents / top) * 100))}%`, background: row.color || "var(--primary)" } })),
                h("span", { class: "tiny dim num" }, `${Math.round((row.revenue_cents / Math.max(1, cards.sales_cents)) * 100)}%`)),
            },
            { key: "revenue_cents", label: "Revenue", align: "right", render: (row) => h("span", { class: "num strong" }, money(row.revenue_cents)) },
            { key: "profit_cents", label: "Profit", align: "right", render: (row) => h("span", { class: "num" }, money(row.profit_cents)) },
          ],
        }),
      })));
    }
    content.appendChild(grid);
  }

  async function renderTable(key) {
    const data = await get(`/reports/${key}`, { from: state.from, to: state.to, ...branchQuery(), ...userQuery() });
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
      actions: h("div", { class: "flex gap-2" },
        button("CSV", { size: "sm", icon: "download", onClick: (event) => exportCurrent(event.currentTarget) }),
        button("PDF", { size: "sm", variant: "soft", icon: "download", onClick: (event) => exportPdf(event.currentTarget) })),
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

  async function exportCurrent(trigger) {
    if (!hasPerm("reports.export")) {
      toast("You need the export permission.", "warning");
      return;
    }
    const run = async () => {
      const key = state.key === "summary" ? "sales" : state.key;
      const query = { from: state.from, to: state.to, ...branchQuery(), ...userQuery() };
      await downloadFile(`/reports/${key}.csv`, query);
      toast("CSV downloaded.", "success");
    };
    try {
      if (trigger) await withButtonSpinner(trigger, run);
      else await run();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function exportPdf(trigger) {
    if (!hasPerm("reports.export")) {
      toast("You need the export permission.", "warning");
      return;
    }
    const key = state.key === "summary" ? "summary" : state.key;
    const query = { from: state.from, to: state.to, ...branchQuery(), ...userQuery() };
    const overlay = busyOverlay("Building your PDF…");
    const started = performance.now();
    try {
      const run = () => downloadFile(`/reports/${key}.pdf`, query);
      if (trigger) await withButtonSpinner(trigger, run);
      else await run();
      const ms = Math.round(performance.now() - started);
      toast(`PDF ready in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}.`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      overlay.close();
    }
  }

  load();
  loadTeam();
  return { el };
}
