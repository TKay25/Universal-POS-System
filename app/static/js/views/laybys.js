/* Lay-by management: deposits, instalments, settlement and cancellations. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, qty as fmtQty, date, dateTime, isoDay, addDays } from "../core/fmt.js";
import { get, post, downloadFile } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig, settings } from "../core/store.js";
import { requireBranchAction } from "../core/branch.js";
import { pageHeader, sectionCard, button, iconButton, table, badge, toast, alertBox, field, textInput,
  textarea, select, moneyInput, modal, drawer, confirmDialog, emptyState, statCard, statusBadge,
  pagination, kvList, formGrid, switchControl, searchLoader } from "../core/ui.js";
import { busyOverlay, withButtonSpinner } from "../core/loading.js";
import { printReceipt } from "./saleDetail.js";

export default async function laybysView(ctx) {
  const el = h("div");
  const filters = { q: "", status: "", page: 1 };
  let methods = [];
  let summary = {};

  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });
  const tableHost = h("div");
  const chipsHost = h("div", { class: "chips" });

  const search = searchLoader(textInput({ placeholder: "Search lay-by number, customer or phone…", className: "input--sm" }));
  search.addEventListener("input", debounce(() => {
    filters.q = search.value.trim();
    filters.page = 1;
    load();
  }, 250));

  el.appendChild(pageHeader({
    title: "Lay-bys",
    subtitle: "Deposits, instalments and goods held for customers until they are paid in full",
    actions: [
      button("Refresh", { icon: "refresh", variant: "ghost", onClick: load }),
      hasPerm("pos.sell")
        ? button("New lay-by", { variant: "primary", icon: "plus", onClick: () => openCreate() })
        : null,
    ].filter(Boolean),
  }));

  if (!moduleOn("layby")) {
    el.appendChild(alertBox("The Lay-by module is switched off. Enable it under Settings → Modules to start using lay-bys.", "warning"));
    return { el };
  }

  el.appendChild(kpiHost);
  el.appendChild(sectionCard({
    title: "Lay-by agreements",
    subtitle: "Active agreements reserve stock until settled or cancelled",
    flush: true,
    actions: h("div", { class: "flex gap-2 items-center wrap" },
      h("div", { style: { width: "250px" } }, search),
      chipsHost),
    body: tableHost,
  }));

  function renderChips() {
    clear(chipsHost);
    for (const [value, label] of [["", "All"], ["active", "Active"], ["completed", "Settled"], ["cancelled", "Cancelled"]]) {
      chipsHost.appendChild(h("button", {
        class: `chip${filters.status === value ? " is-active" : ""}`,
        type: "button",
        onClick: () => {
          filters.status = value;
          filters.page = 1;
          renderChips();
          load();
        },
      }, label));
    }
  }

  function renderSummary() {
    clear(kpiHost);
    kpiHost.appendChild(statCard({ label: "Active lay-bys", value: number(summary.active || 0), icon: "wallet", foot: `${summary.overdue || 0} overdue` }));
    kpiHost.appendChild(statCard({ label: "Outstanding", value: money(summary.outstanding_cents || 0), icon: "cash", foot: "Still to be collected", tone: "warning" }));
    kpiHost.appendChild(statCard({ label: "Reserved stock value", value: money(summary.reserved_value_cents || 0), icon: "box", foot: "Goods held for customers", tone: "accent" }));
    kpiHost.appendChild(statCard({ label: "Settled", value: number(summary.completed || 0), icon: "check", foot: `${summary.cancelled || 0} cancelled`, tone: "success" }));
  }

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/laybys", {
        q: filters.q,
        status: filters.status,
        page: filters.page,
        per_page: 25,
      });
      summary = data.summary || {};
      methods = data.payment_methods || [];
      renderSummary();
      renderChips();
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items || [],
        onRowClick: (row) => openDetail(row.id),
        empty: {
          icon: "wallet",
          title: "No lay-bys yet",
          text: "Take a deposit and reserve goods for a customer paying over time.",
          action: button("New lay-by", { variant: "primary", icon: "plus", onClick: () => openCreate() }),
        },
        columns: [
          {
            key: "number", label: "Lay-by",
            render: (row) => h("div", {}, h("div", { class: "strong mono" }, row.number),
              h("div", { class: "tiny dim" }, date(row.created_at))),
          },
          { key: "customer", label: "Customer", render: (row) => h("div", {}, h("div", {}, row.customer), h("div", { class: "tiny dim" }, `${row.item_count} items`)) },
          { key: "total_cents", label: "Total", align: "right", render: (row) => h("span", { class: "num" }, money(row.total_cents)) },
          { key: "paid_cents", label: "Paid", align: "right", render: (row) => h("span", { class: "num", style: { color: "var(--success)" } }, money(row.paid_cents)) },
          { key: "balance_cents", label: "Balance", align: "right", render: (row) => h("span", { class: "num strong" }, money(row.balance_cents)) },
          {
            key: "due_date", label: "Due",
            render: (row) => row.status === "active"
              ? h("div", {}, h("span", { class: "small" }, date(row.due_date)), row.is_overdue ? badge("Overdue", "danger") : null)
              : h("span", { class: "dim" }, "—"),
          },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              row.status === "active"
                ? iconButton("cash", { size: "sm", variant: "ghost", title: "Take instalment", onClick: () => openDetail(row.id) })
                : null,
              iconButton("print", { size: "sm", variant: "ghost", title: "Statement", onClick: () => printStatement(row.id) }),
              iconButton("chevronRight", { size: "sm", variant: "ghost", title: "Open", onClick: () => openDetail(row.id) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (page) => { filters.page = page; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function printStatement(laybyId) {
    const win = window.open(`/api/laybys/${laybyId}/statement`, "_blank", "width=440,height=800");
    if (!win) toast("Allow pop-ups to print the lay-by statement.", "warning");
  }

  async function downloadStatement(laybyId, number, trigger) {
    const overlay = busyOverlay("Building the lay-by statement…");
    try {
      await withButtonSpinner(trigger, () => downloadFile(`/laybys/${laybyId}/statement.pdf`));
      toast(`Statement ${number}.pdf downloaded.`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      overlay.close();
    }
  }

  function estimate(lines, products) {
    const taxCfg = moduleConfig("tax_engine");
    const includeTax = Boolean(taxCfg.prices_include_tax);
    let net = 0;
    let tax = 0;
    for (const line of lines) {
      const product = products.find((row) => row.id === line.product_id);
      if (!product) continue;
      const rate = product.tax_rate ? Number(product.tax_rate.rate) || 0 : 0;
      const inclusive = product.tax_rate ? Boolean(product.tax_rate.is_inclusive) : includeTax;
      const gross = Math.round(product.price_cents * line.qty);
      if (inclusive) {
        const lineTax = rate ? Math.round(gross - gross / (1 + rate / 100)) : 0;
        tax += lineTax;
        net += gross - lineTax;
      } else {
        const lineTax = Math.round((gross * rate) / 100);
        tax += lineTax;
        net += gross;
      }
    }
    let total = net + tax;
    if (moduleOn("rounding")) {
      const cfg = moduleConfig("rounding");
      const increment = Math.max(1, Number(cfg.increment) || 1);
      total = Math.round(total / increment) * increment;
    }
    return { net, tax, total };
  }

  async function openCreate() {
    if (!requireBranchAction()) return;
    let products = [];
    let customers = [];
    try {
      const [productData, customerData] = await Promise.all([
        get("/products", { per_page: 200, active: "1" }),
        get("/customers", { per_page: 200 }),
      ]);
      products = productData.items;
      customers = customerData.items;
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const cfg = moduleConfig("layby");
    const maxDays = Number(cfg.max_days || 90);
    if (!methods.length) {
      const data = await get("/laybys", { per_page: 1 });
      methods = data.payment_methods || [];
    }

    const customerSelect = select({
      value: "",
      placeholder: customers.length ? "Choose a customer…" : "Add a customer first",
      options: customers.map((row) => ({ value: row.id, label: `${row.name}${row.phone ? ` · ${row.phone}` : ""}` })),
    });
    const productSelect = select({
      value: "",
      placeholder: "Choose a product…",
      options: products.map((row) => ({ value: row.id, label: `${row.name} · ${money(row.price_cents)}${row.track_stock ? ` (${fmtQty(row.stock_qty)} left)` : ""}` })),
    });
    const qtyInput = textInput({ type: "number", min: "1", step: "1", value: "1" });
    const linesHost = h("div", { class: "col gap-2" });
    const lines = [];
    const totalsHost = h("div", { class: "change-due" }, h("span", {}, "Lay-by total"), h("span", { class: "num" }, money(0)));
    const minimumHint = h("div", { class: "tiny dim" });
    const deposit = moneyInput({ placeholder: "0.00" });
    const dueDate = h("input", {
      class: "input",
      type: "date",
      value: isoDay(addDays(Math.min(maxDays, 30))),
      min: isoDay(addDays(1)),
    });
    const methodSelect = select({
      value: methods[0]?.id || "",
      options: methods.map((row) => ({ value: row.id, label: row.name })),
    });
    const note = textarea({ rows: 2, placeholder: "Anything the customer agreed to" });
    const errorHost = h("div");
    const submit = button("Create lay-by", { variant: "primary", icon: "wallet" });

    function recalc() {
      const totals = estimate(lines, products);
      totalsHost.lastChild.textContent = money(totals.total);
      const minimum = Math.max(Number(cfg.min_deposit || 0), Math.round((totals.total * Number(cfg.deposit_percent || 0)) / 100));
      minimumHint.textContent = `Minimum deposit ${money(minimum)} (${cfg.deposit_percent || 0}% of ${money(totals.total)})`;
      return { ...totals, minimum };
    }

    function renderLines() {
      clear(linesHost);
      lines.forEach((line, index) => {
        const product = products.find((row) => row.id === line.product_id);
        linesHost.appendChild(h("div", { class: "flex items-center gap-2", style: { padding: "6px 0", borderBottom: "1px solid var(--border)" } },
          h("div", { class: "grow" },
            h("div", { class: "strong small" }, product?.name || "Product"),
            h("div", { class: "tiny dim" }, `${money(product?.price_cents || 0)} × ${fmtQty(line.qty)}`)),
          h("span", { class: "num small" }, money(Math.round((product?.price_cents || 0) * line.qty))),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, onClick: () => {
            lines.splice(index, 1);
            renderLines();
            recalc();
          } })));
      });
      if (!lines.length) linesHost.appendChild(h("div", { class: "tiny dim" }, "No items yet — add the goods being reserved."));
      recalc();
    }

    const addLine = button("Add item", { size: "sm", icon: "plus", onClick: () => {
      const productId = Number(productSelect.value);
      const qty = Number(qtyInput.value) || 1;
      if (!productId) {
        toast("Choose a product first.", "warning");
        return;
      }
      const existing = lines.find((line) => line.product_id === productId);
      if (existing) existing.qty += qty;
      else lines.push({ product_id: productId, qty });
      qtyInput.value = "1";
      renderLines();
    } });

    submit.addEventListener("click", async () => {
      clear(errorHost);
      if (!customerSelect.value) {
        errorHost.appendChild(alertBox("Select a customer for this lay-by.", "danger"));
        return;
      }
      if (!lines.length) {
        errorHost.appendChild(alertBox("Add at least one item.", "danger"));
        return;
      }
      submit.setLoading(true);
      try {
        const { item } = await post("/laybys", {
          customer_id: Number(customerSelect.value),
          lines,
          deposit_amount: deposit.value,
          due_date: dueDate.value,
          payment_method_id: methodSelect.value ? Number(methodSelect.value) : null,
          note: note.value.trim(),
        });
        instance.close();
        toast(`Lay-by ${item.number} created.`, "success");
        await load();
        showCreated(item);
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        submit.setLoading(false);
      }
    });

    const instance = modal({
      title: "New lay-by",
      subtitle: "Reserve the goods now, collect the balance over time",
      size: "lg",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Customer", control: customerSelect, required: true }),
        h("div", { class: "card card--pad" },
          h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Goods"),
          h("div", { class: "flex gap-2 items-end mt-2" },
            field({ label: "Product", control: productSelect }),
            h("div", { style: { width: "92px" } }, field({ label: "Qty", control: qtyInput })),
            addLine),
          h("div", { class: "mt-3" }, linesHost)),
        totalsHost,
        minimumHint,
        formGrid([
          field({ label: "Deposit paid today", control: deposit, required: true }),
          field({ label: "Deposit method", control: methodSelect }),
          field({ label: "Collection due by", control: dueDate, required: true }),
        ]),
        field({ label: "Note", control: note })),
      footer: [button("Cancel", { onClick: () => instance.close() }), submit],
    });
    renderLines();
  }

  function showCreated(layby) {
    const instance = modal({
      title: `Lay-by ${layby.number}`,
      subtitle: `${layby.customer} · balance ${money(layby.balance_cents)}`,
      size: "sm",
      body: h("div", { class: "col gap-3" },
        h("div", { class: "change-due" }, h("span", {}, "Deposit received"), h("span", { class: "num" }, money(layby.deposit_cents))),
        h("div", { class: "small muted" },
          `Goods reserved until ${date(layby.due_date)}. Remaining balance ${money(layby.balance_cents)}.`)),
      footer: [
        button("Statement", { icon: "print", onClick: () => printStatement(layby.id) }),
        button("Done", { variant: "primary", onClick: () => instance.close() }),
      ],
    });
  }

  async function openDetail(laybyId) {
    let data;
    try {
      data = await get(`/laybys/${laybyId}`);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const layby = data.item;
    methods = data.payment_methods || methods;
    const body = h("div", { class: "col gap-4" });

    function render() {
      clear(body);
      body.appendChild(h("div", { class: "flex items-center gap-2" },
        h("div", { class: "kpi__value fs", style: { "--fs": "22px" } }, money(layby.total_cents)),
        statusBadge(layby.status),
        layby.is_overdue ? badge("Overdue", "danger") : null));

      body.appendChild(kvList([
        ["Lay-by", h("span", { class: "mono" }, layby.number)],
        ["Customer", layby.customer],
        ["Opened", dateTime(layby.created_at)],
        ["Due", layby.status === "active" ? date(layby.due_date) : "—"],
        ...(layby.sale_number ? [["Settled as", layby.sale_number]] : []),
        ...(layby.note ? [["Note", layby.note]] : []),
      ]));

      body.appendChild(h("div", { class: "grid grid--3" },
        miniKpi("Paid", money(layby.paid_cents)),
        miniKpi("Balance", money(layby.balance_cents)),
        miniKpi("Due date", layby.status === "active" ? date(layby.due_date) : "—")));

      body.appendChild(h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Goods reserved"));
      body.appendChild(table({
        compact: true,
        rows: layby.items,
        columns: [
          { key: "name", label: "Item", render: (row) => h("div", {}, h("div", { class: "strong" }, row.name), h("div", { class: "tiny dim" }, row.sku || "")) },
          { key: "qty", label: "Qty", align: "right", render: (row) => fmtQty(row.qty) },
          { key: "unit_price_cents", label: "Price", align: "right", render: (row) => money(row.unit_price_cents) },
          { key: "line_total_cents", label: "Amount", align: "right", render: (row) => money(row.line_total_cents) },
        ],
      }));

      body.appendChild(h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Payments"));
      body.appendChild(table({
        compact: true,
        rows: layby.payments,
        empty: { icon: "cash", title: "No payments recorded" },
        columns: [
          { key: "created_at", label: "When", render: (row) => dateTime(row.created_at) },
          { key: "method_name", label: "Method", render: (row) => row.method_name },
          { key: "cashier", label: "Taken by", render: (row) => h("span", { class: "dim" }, row.cashier) },
          { key: "amount_cents", label: "Amount", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.amount_cents)) },
        ],
      }));
    }

    function miniKpi(label, value) {
      return h("div", { class: "card card--pad" },
        h("div", { class: "kpi__label fs", style: { "--fs": "10px" } }, label),
        h("div", { class: "strong fs", style: { "--fs": "15px", marginTop: "4px" } }, value));
    }

    const footer = [
      button("Statement", { icon: "print", onClick: () => printStatement(layby.id) }),
      button("PDF", {
        icon: "download",
        onClick: (event) => downloadStatement(layby.id, layby.number, event.currentTarget),
      }),
      h("div", { class: "grow" }),
      layby.status === "active"
        ? button("Cancel lay-by", { variant: "ghost", danger: true, onClick: () => openCancel(layby) })
        : null,
      layby.status === "active"
        ? button("Take instalment", { variant: "primary", icon: "cash", onClick: () => openPayment(layby.id) })
        : null,
    ].filter(Boolean);

    const instanceDrawer = drawer({
      title: `Lay-by ${layby.number}`,
      subtitle: layby.customer,
      size: "lg",
      body,
      footer,
    });
    render();

    async function openPayment(id) {
      if (!requireBranchAction()) return;
      let detail = layby;
      if (id !== layby.id) {
        try {
          detail = (await get(`/laybys/${id}`)).item;
        } catch (error) {
          toast(error.message, "error");
          return;
        }
      }
      const amount = moneyInput({ value: (detail.balance_cents / 100).toFixed(2) });
      const method = select({ value: methods[0]?.id || "", options: methods.map((row) => ({ value: row.id, label: row.name })) });
      const reference = textInput({ placeholder: "Reference (for mobile money / card)" });
      const errorHost = h("div");
      const submit = button("Record payment", { variant: "primary", icon: "cash" });
      submit.addEventListener("click", async () => {
        submit.setLoading(true);
        clear(errorHost);
        try {
          const { item } = await post(`/laybys/${detail.id}/payments`, {
            amount: amount.value,
            payment_method_id: method.value ? Number(method.value) : null,
            reference: reference.value.trim(),
          });
          toast(item.status === "completed" ? "Lay-by settled in full." : "Instalment recorded.", "success");
          paymentModal.close();
          instanceDrawer.close();
          await load();
          if (item.status === "completed" && item.sale_id) {
            setTimeout(() => printReceipt(item.sale_id), 400);
          }
        } catch (error) {
          errorHost.appendChild(alertBox(error.message, "danger"));
        } finally {
          submit.setLoading(false);
        }
      });
      const paymentModal = modal({
        title: "Take an instalment",
        subtitle: `${detail.number} · balance ${money(detail.balance_cents)}`,
        size: "sm",
        body: h("div", { class: "col gap-3" }, errorHost,
          field({ label: "Amount", control: amount, required: true }),
          field({ label: "Method", control: method }),
          field({ label: "Reference", control: reference })),
        footer: [button("Cancel", { onClick: () => paymentModal.close() }), submit],
      });
    }

    function openCancel(target) {
      const reason = textarea({ rows: 2, placeholder: "Why is this lay-by being cancelled?" });
      const restock = switchControl({ checked: moduleConfig("layby").restock_on_cancel !== false, label: "Return the goods to stock" });
      const fee = Number(moduleConfig("layby").cancellation_fee_percent || 0);
      const errorHost = h("div");
      const submit = button("Cancel lay-by", { variant: "danger" });
      submit.addEventListener("click", async () => {
        if (!reason.value.trim()) {
          clear(errorHost);
          errorHost.appendChild(alertBox("A reason is required.", "danger"));
          return;
        }
        submit.setLoading(true);
        try {
          const result = await post(`/laybys/${target.id}/cancel`, {
            reason: reason.value.trim(),
            restock: restock.input.checked,
          });
          toast(`Lay-by cancelled. Refund due ${money(result.refund_due_cents)}${result.forfeited_cents ? ` (fee ${money(result.forfeited_cents)})` : ""}.`, "success");
          cancelModal.close();
          instanceDrawer.close();
          await load();
        } catch (error) {
          errorHost.appendChild(alertBox(error.message, "danger"));
        } finally {
          submit.setLoading(false);
        }
      });
      const cancelModal = modal({
        title: "Cancel lay-by",
        subtitle: `${target.number} · ${target.customer}`,
        size: "sm",
        body: h("div", { class: "col gap-3" }, errorHost,
          alertBox(fee
            ? `A ${fee}% cancellation fee applies to the amount already paid. Any refund is added to the customer's store credit.`
            : "Amounts already paid will be added to the customer's store credit balance.", "info"),
          field({ label: "Reason", control: reason, required: true }),
          restock),
        footer: [button("Keep lay-by", { onClick: () => cancelModal.close() }), submit],
      });
    }
  }

  renderChips();
  await load();
  return { el, onActivate: () => load() };
}
