/* Shared sale drawer: details, receipt, refunds and voids. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, qty as fmtQty, dateTime } from "../core/fmt.js";
import { hasPerm, moduleConfig, setting } from "../core/store.js";
import { get, post } from "../core/http.js";
import {
  drawer, button, iconButton, statusBadge, table, kvList, modal, field, textarea, switchControl,
  select, toast, badge, alertBox, confirmDialog, moneyInput,
} from "../core/ui.js";

export function printReceipt(saleId) {
  const win = window.open(`/api/sales/${saleId}/receipt?auto_print=1`, "_blank", "width=440,height=800");
  if (!win) toast("Allow pop-ups to print receipts.", "warning");
}

export async function openSaleDetail(saleId, { onChanged } = {}) {
  let sale;
  try {
    const data = await get(`/sales/${saleId}`);
    sale = data.item;
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  const refundCfg = moduleConfig("refunds");
  const refundable = sale.status !== "voided"
    && sale.status !== "refunded"
    && hasPerm("sales.refund")
    && sale.items.some((item) => item.refunded_qty < item.qty);

  const body = h("div", { class: "col gap-4" });

  function render() {
    clear(body);
    body.appendChild(h("div", { class: "flex items-center gap-2" },
      h("div", { class: "kpi__value fs", style: { "--fs": "24px" } }, money(sale.total_cents)),
      statusBadge(sale.status)));

    body.appendChild(kvList([
      ["Receipt", h("span", { class: "mono" }, sale.number)],
      ["When", dateTime(sale.created_at)],
      ["Cashier", sale.cashier],
      ["Customer", sale.customer || "Walk-in"],
      ...(sale.register ? [["Register", sale.register]] : []),
      ...(sale.location ? [["Location", sale.location]] : []),
      ...(sale.note ? [["Note", sale.note]] : []),
      ...(sale.discount_label ? [["Discount", sale.discount_label]] : []),
    ]));

    body.appendChild(sectionTitle(`Items (${sale.items.length})`));
    body.appendChild(table({
      compact: true,
      columns: [
        { key: "name", label: "Item", render: (row) => h("div", {},
          h("div", { class: "strong" }, row.name),
          row.note ? h("div", { class: "tiny dim" }, row.note) : null,
          row.refunded_qty ? h("div", { class: "tiny", style: { color: "var(--warning)" } }, `${fmtQty(row.refunded_qty)} refunded`) : null) },
        { key: "qty", label: "Qty", align: "right", render: (row) => fmtQty(row.qty) },
        { key: "unit_price_cents", label: "Price", align: "right", render: (row) => money(row.unit_price_cents) },
        { key: "line_total_cents", label: "Total", align: "right", render: (row) => money(row.line_total_cents) },
      ],
      rows: sale.items,
    }));

    body.appendChild(sectionTitle("Totals"));
    const totals = [
      ["Subtotal", money(sale.subtotal_cents)],
      ...(sale.discount_cents ? [["Discount", `-${money(sale.discount_cents)}`]] : []),
      ...(sale.tax_cents ? [["Tax", money(sale.tax_cents)]] : []),
      ...(sale.service_charge_cents ? [["Service charge", money(sale.service_charge_cents)]] : []),
      ...(sale.tip_cents ? [["Tip", money(sale.tip_cents)]] : []),
      ...(sale.rounding_cents ? [["Rounding", money(sale.rounding_cents)]] : []),
      ...(sale.refunded_cents ? [["Refunded", `-${money(sale.refunded_cents)}`]] : []),
    ];
    body.appendChild(kvList(totals));

    body.appendChild(sectionTitle("Payments"));
    body.appendChild(h("div", { class: "col gap-1" },
      sale.payments.map((payment) => h("div", { class: "flex justify-between small" },
        h("span", {}, payment.method_name, payment.reference ? h("span", { class: "dim" }, ` · ${payment.reference}`) : null),
        h("span", { class: "num" }, money(payment.amount_cents)))),
      sale.change_cents ? h("div", { class: "flex justify-between small dim" },
        h("span", {}, "Change"), h("span", { class: "num" }, money(sale.change_cents))) : null));

    if (sale.loyalty_points_earned || sale.loyalty_points_redeemed) {
      body.appendChild(h("div", { class: "flex gap-2" },
        badge(`+${sale.loyalty_points_earned} points`, "success"),
        sale.loyalty_points_redeemed ? badge(`-${sale.loyalty_points_redeemed} redeemed`, "warning") : null));
    }

    if (sale.refunds && sale.refunds.length) {
      body.appendChild(sectionTitle("Refunds"));
      body.appendChild(h("div", { class: "col gap-2" }, sale.refunds.map((refund) => h("div", { class: "card card--pad" },
        h("div", { class: "flex justify-between" },
          h("span", { class: "strong" }, money(refund.amount_cents)),
          h("span", { class: "tiny dim" }, dateTime(refund.created_at))),
        h("div", { class: "small muted" }, refund.reason || "No reason recorded"),
        h("div", { class: "tiny dim", style: { marginTop: "4px" } },
          `${refund.user} · ${refund.method}${refund.restock ? " · restocked" : ""}`)))));
    }
  }

  const footer = [
    button("Print receipt", { icon: "print", onClick: () => printReceipt(sale.id) }),
    h("div", { class: "grow" }),
    hasPerm("sales.void") && sale.status !== "voided" && !sale.refunded_cents
      ? button("Void sale", { variant: "ghost", icon: "x", onClick: () => openVoid() })
      : null,
    refundable
      ? button("Refund", { variant: "primary", icon: "rotate", onClick: () => openRefund() })
      : null,
  ];

  const instance = drawer({ title: `Sale ${sale.number}`, subtitle: sale.customer || "Walk-in customer", body, footer, size: "lg" });
  render();

  async function refresh() {
    try {
      const data = await get(`/sales/${sale.id}`);
      sale = data.item;
      render();
      onChanged?.();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openRefund() {
    const lines = sale.items
      .filter((item) => item.qty - item.refunded_qty > 0)
      .map((item) => {
        const remaining = item.qty - item.refunded_qty;
        const unit = item.line_total_cents / item.qty;
        const check = h("input", { type: "checkbox", checked: true, style: { accentColor: "var(--primary)" } });
        const qtyInput = moneyInput({ value: remaining.toFixed(2).replace(/\.00$/, ""), step: "0.001", min: "0" });
        qtyInput.type = "number";
        qtyInput.style.maxWidth = "90px";
        const row = h("div", { class: "flex items-center gap-3", style: { padding: "9px 0", borderBottom: "1px solid var(--border)" } },
          check,
          h("div", { class: "grow" },
            h("div", { class: "strong" }, item.name),
            h("div", { class: "tiny dim" }, `${fmtQty(remaining)} available · ${money(unit)} each`)),
          qtyInput);
        row.read = () => (check.checked ? Math.min(remaining, Number(qtyInput.value) || 0) : 0);
        return { row, unit, item };
      });

    const estimate = h("div", { class: "change-due" }, h("span", {}, "Estimated refund"), h("span", { class: "num" }, money(0)));
    function recalc() {
      const total = lines.reduce((sum, line) => sum + Math.round(line.unit * line.row.read()), 0);
      estimate.lastChild.textContent = money(total);
      return total;
    }
    lines.forEach(({ row }) => {
      row.querySelector("input[type=checkbox]").addEventListener("change", recalc);
      row.querySelector("input[type=number]").addEventListener("input", recalc);
    });

    const reason = textarea({ placeholder: "What happened?", rows: 2 });
    const restock = switchControl({ checked: moduleConfig("refunds").restock_by_default !== false, label: "Put items back in stock" });
    const method = select({
      value: "original",
      options: [
        { value: "original", label: "Refund original payment" },
        { value: "cash", label: "Cash payout" },
        ...(sale.customer_id ? [{ value: "store_credit", label: "Store credit" }] : []),
      ],
    });
    const errorHost = h("div");
    const submit = button("Issue refund", { variant: "primary", icon: "rotate" });

    submit.addEventListener("click", async () => {
      const items = lines.map((line) => ({ sale_item_id: line.item.id, qty: line.row.read() })).filter((line) => line.qty > 0);
      if (!items.length) {
        toast("Choose at least one item to refund.", "warning");
        return;
      }
      if (moduleConfig("refunds").require_reason !== false && !reason.value.trim()) {
        clear(errorHost);
        errorHost.appendChild(alertBox("A refund reason is required.", "danger"));
        return;
      }
      submit.setLoading(true);
      clear(errorHost);
      try {
        await post(`/sales/${sale.id}/refund`, {
          items,
          reason: reason.value.trim(),
          restock: restock.input.checked,
          method: method.value,
        });
        toast("Refund processed.", "success");
        refundModal.close();
        await refresh();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        submit.setLoading(false);
      }
    });

    const refundModal = modal({
      title: "Refund items",
      subtitle: sale.number,
      size: "md",
      body: h("div", { class: "col gap-3" },
        errorHost,
        h("div", {}, lines.map((line) => line.row)),
        estimate,
        field({ label: "Reason", control: reason, required: moduleConfig("refunds").require_reason !== false }),
        h("div", { class: "flex gap-4 wrap" },
          field({ label: "Refund to", control: method }),
          h("div", { style: { marginTop: "24px" } }, restock))),
      footer: [button("Cancel", { onClick: () => refundModal.close() }), submit],
    });
    recalc();
  }

  function openVoid() {
    const reason = textarea({ placeholder: "Why is this sale being voided?", rows: 2 });
    const errorHost = h("div");
    const submit = button("Void sale", { variant: "danger" });
    submit.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Void this sale?",
        message: "Stock will be returned and the sale will be marked as voided. This cannot be undone.",
        confirmLabel: "Void sale",
        danger: true,
      });
      if (!ok) return;
      submit.setLoading(true);
      try {
        await post(`/sales/${sale.id}/void`, { reason: reason.value.trim() });
        toast("Sale voided.", "success");
        voidModal.close();
        await refresh();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        submit.setLoading(false);
      }
    });
    const voidModal = modal({
      title: "Void sale",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, field({ label: "Reason", control: reason })),
      footer: [button("Cancel", { onClick: () => voidModal.close() }), submit],
    });
  }

  return instance;
}

function sectionTitle(text) {
  return h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650", marginTop: "4px" } }, text);
}
