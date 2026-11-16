/* Cash drawer sessions and reconciliation. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, dateTime, date } from "../core/fmt.js";
import { get, post } from "../core/http.js";
import {
  pageHeader, sectionCard, button, table, badge, toast, alertBox, field, textarea, moneyInput,
  statCard, modal, statusBadge, pagination, emptyState, kvList,
} from "../core/ui.js";

export default async function shiftsView(ctx) {
  const el = h("div");
  let current = null;
  let summary = {};
  let page = 1;

  const currentHost = h("div");
  const historyHost = h("div");
  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });

  el.appendChild(pageHeader({
    title: "Cash drawer",
    subtitle: "Open, reconcile and close every shift",
    actions: [
      button("Open drawer", { variant: "primary", icon: "plus", onClick: openOpenModal }),
      button("Close drawer", { icon: "check", onClick: openCloseModal }),
    ],
  }));
  el.appendChild(kpiHost);
  el.appendChild(currentHost);
  el.appendChild(h("div", { class: "mt-4" }));
  el.appendChild(sectionCard({ title: "Shift history", subtitle: "Variances and counted cash", flush: true, body: historyHost }));

  async function load() {
    try {
      const [currentData, history] = await Promise.all([
        get("/shifts/current"),
        get("/shifts", { page, per_page: 25 }),
      ]);
      current = currentData.item;
      summary = currentData.summary || {};
      renderKpis(history.items || []);
      renderCurrent();
      clear(historyHost);
      historyHost.appendChild(table({
        rows: history.items || [],
        empty: { icon: "clock", title: "No shifts yet", text: "Open the drawer to start your first shift." },
        columns: [
          { key: "user", label: "Cashier", render: (row) => h("div", {}, h("div", { class: "strong" }, row.user), h("div", { class: "tiny dim" }, row.register || "—")) },
          { key: "opened_at", label: "Opened", render: (row) => dateTime(row.opened_at) },
          { key: "closed_at", label: "Closed", render: (row) => row.closed_at ? dateTime(row.closed_at) : badge("Open", "success") },
          { key: "opening_float_cents", label: "Float", align: "right", render: (row) => money(row.opening_float_cents) },
          { key: "expected_cash_cents", label: "Expected", align: "right", render: (row) => money(row.expected_cash_cents) },
          { key: "counted_cash_cents", label: "Counted", align: "right", render: (row) => row.counted_cash_cents ? money(row.counted_cash_cents) : h("span", { class: "dim" }, "—") },
          {
            key: "variance_cents", label: "Variance", align: "right",
            render: (row) => row.closed_at
              ? h("span", { class: "num strong", style: { color: row.variance_cents === 0 ? "var(--success)" : "var(--danger)" } }, money(row.variance_cents))
              : h("span", { class: "dim" }, "—"),
          },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
        ],
      }));
      historyHost.appendChild(pagination(history.meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(currentHost);
      currentHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderKpis(items) {
    clear(kpiHost);
    const sales = items.reduce((sum, row) => sum + (row.sales_cents || 0), 0);
    const variance = items.reduce((sum, row) => sum + (row.variance_cents || 0), 0);
    const closed = items.filter((row) => row.status === "closed").length;
    kpiHost.appendChild(statCard({ label: "Shift sales", value: money(sales), icon: "cash", foot: `${items.length} shifts shown` }));
    kpiHost.appendChild(statCard({ label: "Total variance", value: money(variance), icon: "warn", foot: variance === 0 ? "Perfectly balanced" : "Review differences", tone: variance ? "warning" : "success" }));
    kpiHost.appendChild(statCard({ label: "Closed shifts", value: number(closed), icon: "check", foot: `${items.length - closed} still open` }));
    kpiHost.appendChild(statCard({ label: "Current float", value: money(current?.opening_float_cents || 0), icon: "wallet", foot: current ? "Drawer is open" : "No open shift", tone: current ? "accent" : "" }));
  }

  function renderCurrent() {
    clear(currentHost);
    if (!current) {
      currentHost.appendChild(sectionCard({
        title: "No drawer open",
        subtitle: "Open a shift to track cash and reconcile at the end of the day",
        body: h("div", { class: "flex items-center gap-3 wrap" },
          h("div", { class: "empty__icon" }, icon("clock")),
          h("div", { class: "grow" },
            h("div", { class: "strong" }, "Start a new shift"),
            h("div", { class: "small dim" }, "Count your opening float first, then take payments as usual.")),
          button("Open drawer", { variant: "primary", icon: "plus", onClick: openOpenModal })),
      }));
      return;
    }
    currentHost.appendChild(sectionCard({
      title: "Current shift",
      subtitle: `Opened ${dateTime(current.opened_at)} · ${current.user}`,
      actions: [badge("Open", "success"), button("Close drawer", { size: "sm", variant: "primary", icon: "check", onClick: openCloseModal })],
      body: h("div", { class: "grid grid--3" },
        statCard({ label: "Opening float", value: money(current.opening_float_cents), icon: "wallet" }),
        statCard({ label: "Cash sales", value: money(summary.cash_sales_cents || 0), icon: "cash" }),
        statCard({ label: "Cash refunds", value: money(summary.cash_refunds_cents || 0), icon: "rotate" }),
        statCard({ label: "Expected in drawer", value: money(summary.expected_cash_cents || 0), icon: "check", tone: "accent" })),
    }));
  }

  function openOpenModal() {
    const floatInput = moneyInput({ value: "0.00" });
    const notes = textarea({ rows: 2, placeholder: "Opening notes (optional)" });
    const errorHost = h("div");
    const instance = modal({
      title: "Open cash drawer",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Opening float", control: floatInput, hint: "Cash already in the drawer before the first sale." }),
        field({ label: "Notes", control: notes })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Open drawer", { variant: "primary", onClick: async () => {
        try {
          await post("/shifts/open", { opening_float: Number(floatInput.value) || 0, notes: notes.value.trim() });
          toast("Drawer opened.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function openCloseModal() {
    if (!current) {
      toast("There is no open shift to close.", "warning");
      return;
    }
    const counted = moneyInput({ value: "" });
    const notes = textarea({ rows: 2, placeholder: "Notes for the handover (optional)" });
    const errorHost = h("div");
    const variancePreview = h("div", { class: "change-due" }, h("span", {}, "Expected in drawer"), h("span", { class: "num" }, money(summary.expected_cash_cents || 0)));
    const instance = modal({
      title: "Close cash drawer",
      subtitle: `Opened ${dateTime(current.opened_at)} by ${current.user}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        h("div", { class: "card card--pad" }, kvList([
          ["Opening float", money(current.opening_float_cents)],
          ["Cash sales", money(summary.cash_sales_cents || 0)],
          ["Cash refunds", money(summary.cash_refunds_cents || 0)],
          ["Expected", money(summary.expected_cash_cents || 0)],
        ])),
        field({ label: "Counted cash", control: counted, hint: "Enter the exact amount you counted." }),
        variancePreview,
        field({ label: "Notes", control: notes })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Close drawer", { variant: "primary", onClick: async () => {
        try {
          const payload = { notes: notes.value.trim() };
          if (counted.value !== "") payload.counted_cash = Number(counted.value) || 0;
          await post(`/shifts/${current.id}/close`, payload);
          toast("Drawer closed and reconciled.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
    counted.addEventListener("input", () => {
      const expected = summary.expected_cash_cents || 0;
      const actual = Math.round((Number(counted.value) || 0) * 100);
      const variance = actual - expected;
      variancePreview.firstChild.textContent = variance === 0 ? "Balanced" : variance > 0 ? "Over by" : "Short by";
      variancePreview.lastChild.textContent = money(Math.abs(variance));
      variancePreview.style.background = variance === 0 ? "color-mix(in srgb, var(--success) 12%, transparent)" : "var(--danger-soft)";
      variancePreview.style.color = variance === 0 ? "var(--success)" : "var(--danger)";
    });
  }

  load();
  return { el };
}
