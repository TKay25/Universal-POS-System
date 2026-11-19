/* Sales history with filters, receipts and drill-down. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, date, dateTime, isoDay, addDays } from "../core/fmt.js";
import { get, post } from "../core/http.js";
import { hasPerm, moduleConfig } from "../core/store.js";
import { branchQuery, branchScope } from "../core/branch.js";
import { pageHeader, sectionCard, button, iconButton, table, pagination, statusBadge, toast, alertBox,
  field, textInput, select, modal, badge, moneyText, searchLoader } from "../core/ui.js";
import { openSaleDetail, printReceipt } from "./saleDetail.js";

export default async function salesView(ctx) {
  const el = h("div");
  const filters = { q: "", status: "", from: isoDay(), to: isoDay(), userId: "" };
  let page = 1;
  let meta = null;

  const tableHost = h("div");
  const summaryHost = h("div", { class: "grid grid--kpi mb-4" });

  const searchInput = searchLoader(textInput({ placeholder: "Search receipt or customer…", className: "input--sm" }));
  searchInput.addEventListener("input", debounce(() => {
    filters.q = searchInput.value.trim();
    page = 1;
    load();
  }, 260));

  const statusSelect = select({
    value: "",
    options: [
      { value: "", label: "All statuses" },
      { value: "completed", label: "Completed" },
      { value: "partially_refunded", label: "Partially refunded" },
      { value: "refunded", label: "Refunded" },
      { value: "voided", label: "Voided" },
    ],
    onChange: (e) => { filters.status = e.target.value; page = 1; load(); },
  });

  const fromInput = h("input", { class: "input input--sm", type: "date", value: filters.from, onchange: (e) => {
    filters.from = e.target.value;
    activeRange = null;
    renderRangeChips();
    page = 1;
    load();
  } });
  const toInput = h("input", { class: "input input--sm", type: "date", value: filters.to, onchange: (e) => {
    filters.to = e.target.value;
    activeRange = null;
    renderRangeChips();
    page = 1;
    load();
  } });

  const teamSelect = select({
    value: "",
    options: [
      { value: "", label: "All users" },
      { value: "me", label: "Only me" },
    ],
    onChange: (e) => {
      filters.userId = e.target.value;
      page = 1;
      load();
    },
  });

  async function loadTeam() {
    if (!hasPerm("reports.view")) return;
    try {
      const data = await get("/reports/team");
      const current = teamSelect.value;
      clear(teamSelect);
      teamSelect.appendChild(h("option", { value: "" }, "All users"));
      teamSelect.appendChild(h("option", { value: "me" }, "Only me"));
      for (const member of data.items || []) {
        teamSelect.appendChild(h("option", { value: String(member.id), selected: String(current) === String(member.id) }, member.name));
      }
    } catch { /* the filter simply stays with all/only me */ }
  }

  const rangeChips = h("div", { class: "chips" });
  let activeRange = 0;
  const RANGES = [["Today", 0], ["7 days", 6], ["30 days", 29], ["90 days", 89]];
  function renderRangeChips() {
    clear(rangeChips);
    for (const [label, days] of RANGES) {
      rangeChips.appendChild(h("button", {
        class: `chip${activeRange === days ? " is-active" : ""}`,
        type: "button",
        onClick: () => {
          activeRange = days;
          filters.from = isoDay(addDays(-days));
          filters.to = isoDay();
          fromInput.value = filters.from;
          toInput.value = filters.to;
          renderRangeChips();
          page = 1;
          load();
        },
      }, label));
    }
  }
  renderRangeChips();

  el.appendChild(pageHeader({
    title: "Sales",
    subtitle: `${branchScope().label} · every ticket, refund and void in one ledger`,
    actions: [
      button("Find receipt", { icon: "search", onClick: openReceiptLookup }),
      hasPerm("reports.export")
        ? button("Export", { icon: "download", onClick: () => exportCsv() })
        : null,
      hasPerm("pos.sell") && !branchScope().all
        ? button("New sale", { variant: "primary", icon: "plus", onClick: () => ctx.navigate("/pos") })
        : null,
    ],
  }));

  el.appendChild(summaryHost);
  el.appendChild(sectionCard({
    title: "Transactions",
    subtitle: "Click a row to open the sale",
    flush: true,
    actions: h("div", { class: "flex gap-2 items-center wrap" },
      h("div", { style: { width: "210px" } }, searchInput),
      h("div", { style: { width: "150px" } }, statusSelect),
      h("div", { style: { width: "170px" } }, teamSelect)),
    body: h("div", {},
      h("div", { class: "flex gap-2 items-center wrap", style: { padding: "10px 12px", borderBottom: "1px solid var(--border)" } },
        rangeChips,
        h("div", { class: "flex gap-2 items-center", style: { marginLeft: "auto" } },
          h("span", { class: "tiny dim" }, "From"), fromInput,
          h("span", { class: "tiny dim" }, "To"), toInput)),
      tableHost),
  }));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/sales", {
        q: filters.q,
        status: filters.status,
        from: filters.from,
        to: filters.to,
        mine: filters.userId === "me" ? 1 : "",
        user_id: filters.userId && filters.userId !== "me" ? filters.userId : undefined,
        page,
        per_page: 25,
        ...branchQuery(),
      });
      meta = data.meta;
      renderSummary(data.items || [], data.meta);
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items || [],
        onRowClick: (row) => openSaleDetail(row.id, { onChanged: load }),
        empty: { icon: "receipt", title: "No sales found", text: "Adjust the filters or take your first sale." },
        columns: [
          {
            key: "number", label: "Receipt",
            render: (row) => h("div", {},
              h("div", { class: "strong mono" }, row.number),
              h("div", { class: "tiny dim" }, dateTime(row.created_at))),
          },
          { key: "customer", label: "Customer", render: (row) => h("div", {}, h("div", {}, row.customer), h("div", { class: "tiny dim" }, row.cashier)) },
          {
            key: "payment_methods", label: "Payment",
            render: (row) => h("div", { class: "flex gap-1 wrap" }, (row.payment_methods || []).map((method) => badge(method))),
          },
          { key: "item_count", label: "Items", align: "right", render: (row) => number(row.item_count, 0) },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
          {
            key: "total_cents", label: "Total", align: "right",
            render: (row) => h("div", {},
              h("div", { class: "strong num" }, money(row.total_cents)),
              row.refunded_cents ? h("div", { class: "tiny", style: { color: "var(--danger)" } }, `-${money(row.refunded_cents)}`) : null),
          },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              iconButton("print", { size: "sm", variant: "ghost", title: "Print receipt", onClick: () => printReceipt(row.id) }),
              iconButton("chevronRight", { size: "sm", variant: "ghost", title: "Open", onClick: () => openSaleDetail(row.id, { onChanged: load }) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderSummary(items, meta) {
    clear(summaryHost);
    const total = items.reduce((sum, row) => sum + (row.status === "voided" ? 0 : row.total_cents), 0);
    const refunded = items.reduce((sum, row) => sum + (row.refunded_cents || 0), 0);
    const refunds = items.filter((row) => row.refunded_cents).length;
    const avg = items.length ? Math.round(total / items.length) : 0;
    summaryHost.appendChild(kpi("Shown sales", money(total), "cash", `${meta?.total || items.length} matching records`));
    summaryHost.appendChild(kpi("Average ticket", money(avg), "trend", "Across displayed rows"));
    summaryHost.appendChild(kpi("Refunded", money(refunded), "rotate", `${refunds} tickets with refunds`, refunded ? "warning" : ""));
    summaryHost.appendChild(kpi("Voids", String(items.filter((row) => row.status === "voided").length), "x", "Cancelled transactions", "danger"));
  }

  function kpi(label, value, iconName, foot, tone = "") {
    return h("div", { class: `kpi kpi--compact${tone ? ` kpi--${tone}` : ""}` },
      h("div", { class: "kpi__icon" }, icon(iconName)),
      h("div", { class: "kpi__label" }, label),
      h("div", { class: "kpi__value" }, value),
      h("div", { class: "kpi__foot" }, foot));
  }

  async function exportCsv() {
    const { downloadFile } = await import("../core/http.js");
    await downloadFile("/reports/sales.csv", {
      from: filters.from,
      to: filters.to,
      user_id: filters.userId && filters.userId !== "me" ? filters.userId : undefined,
      ...branchQuery(),
    });
    toast("Sales export downloaded.", "success");
  }

  function openReceiptLookup() {
    const input = textInput({ placeholder: "e.g. REC-00042" });
    const errorHost = h("div");
    const instance = modal({
      title: "Find a receipt",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, field({ label: "Receipt number", control: input })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Open sale", {
        variant: "primary",
        onClick: async () => {
          try {
            const { item } = await post("/sales/lookup-receipt", { number: input.value.trim() });
            instance.close();
            openSaleDetail(item.id, { onChanged: load });
          } catch (error) {
            clear(errorHost);
            errorHost.appendChild(alertBox(error.message, "danger"));
          }
        },
      })],
    });
  }

  load();
  loadTeam();
  return { el, onActivate: () => {} };
}
