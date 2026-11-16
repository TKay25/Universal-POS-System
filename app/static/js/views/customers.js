/* Customer directory with history and balances. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, date, dateTime } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, pagination, badge, toast, alertBox, field,
  textInput, textarea, select, switchControl, modal, drawer, confirmDialog, formGrid, moneyInput,
  emptyState, statCard, statusBadge, kvList, avatar,
} from "../core/ui.js";
import { openSaleDetail } from "./saleDetail.js";

export default async function customersView(ctx) {
  const el = h("div");
  const filters = { q: "" };
  let page = 1;
  let customFields = [];
  let customers = [];

  const tableHost = h("div");
  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });

  const searchInput = textInput({ placeholder: "Search name, phone or email…", className: "input--sm" });
  searchInput.addEventListener("input", debounce(() => {
    filters.q = searchInput.value.trim();
    page = 1;
    load();
  }, 250));

  el.appendChild(pageHeader({
    title: "Customers",
    subtitle: "Relationships, loyalty and store credit",
    actions: [
      moduleOn("loyalty")
        ? badge(`Loyalty on · ${number(moduleConfig("loyalty").points_per_100, 0)} pts per 100`, "primary")
        : null,
      button("Add customer", { variant: "primary", icon: "plus", onClick: () => openCustomerForm() }),
    ].filter(Boolean),
  }));
  el.appendChild(kpiHost);
  el.appendChild(sectionCard({
    title: "Directory",
    flush: true,
    actions: h("div", { style: { width: "250px" } }, searchInput),
    body: tableHost,
  }));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/customers", { q: filters.q, page, per_page: 40 });
      customers = data.items;
      customFields = data.custom_fields || [];
      renderKpis(data.items, data.meta);
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items,
        onRowClick: (row) => openCustomerDetail(row.id),
        empty: {
          icon: "users",
          title: "No customers yet",
          text: "Add regulars to track loyalty, credit and purchase history.",
          action: button("Add customer", { variant: "primary", icon: "plus", onClick: () => openCustomerForm() }),
        },
        columns: [
          {
            key: "name", label: "Customer",
            render: (row) => h("div", { class: "flex items-center gap-2" },
              avatar(row.name, "#5b5bd6", "sm"),
              h("div", {}, h("div", { class: "strong" }, row.name),
                h("div", { class: "tiny dim" }, row.email || row.phone || "No contact"))),
          },
          { key: "phone", label: "Phone", render: (row) => row.phone || h("span", { class: "dim" }, "—") },
          { key: "visits", label: "Visits", align: "right", render: (row) => number(row.visits) },
          { key: "total_spent_cents", label: "Lifetime spend", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.total_spent_cents)) },
          {
            key: "loyalty_points", label: "Points", align: "right",
            render: (row) => moduleOn("loyalty") ? badge(`${number(row.loyalty_points)}`, "primary") : h("span", { class: "dim" }, "—"),
          },
          {
            key: "credit_balance_cents", label: "Credit", align: "right",
            render: (row) => row.credit_balance_cents ? h("span", { class: "num" }, money(row.credit_balance_cents)) : h("span", { class: "dim" }, "—"),
          },
          { key: "last_visit_at", label: "Last visit", render: (row) => h("span", { class: "dim" }, row.last_visit_at ? date(row.last_visit_at) : "Never") },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              iconButton("eye", { size: "sm", variant: "ghost", title: "Open", onClick: () => openCustomerDetail(row.id) }),
              iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openCustomerForm(row) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderKpis(items, meta) {
    clear(kpiHost);
    const total = meta?.total || items.length;
    const spend = items.reduce((sum, row) => sum + (row.total_spent_cents || 0), 0);
    const points = items.reduce((sum, row) => sum + (row.loyalty_points || 0), 0);
    const credit = items.reduce((sum, row) => sum + (row.credit_balance_cents || 0), 0);
    kpiHost.appendChild(statCard({ label: "Customers", value: number(total), icon: "users", foot: "In this workspace" }));
    kpiHost.appendChild(statCard({ label: "Lifetime spend", value: money(spend), icon: "trend", foot: "Across shown customers", tone: "success" }));
    kpiHost.appendChild(statCard({ label: "Points outstanding", value: number(points), icon: "star", foot: "Loyalty liability", tone: "accent" }));
    kpiHost.appendChild(statCard({ label: "Store credit", value: money(credit), icon: "wallet", foot: "Redeemable balance", tone: credit ? "warning" : "" }));
  }

  function openCustomerForm(customer = null) {
    const isEdit = Boolean(customer?.id);
    const name = textInput({ value: customer?.name || "", placeholder: "Full name" });
    const email = textInput({ type: "email", value: customer?.email || "", placeholder: "name@email.com" });
    const phone = textInput({ value: customer?.phone || "", placeholder: "+263 …" });
    const address = textInput({ value: customer?.address || "", placeholder: "Address" });
    const taxNumber = textInput({ value: customer?.tax_number || "", placeholder: "Tax / VAT number" });
    const notes = textarea({ value: customer?.notes || "", rows: 2 });
    const creditLimit = moneyInput({ value: customer ? (customer.credit_limit_cents / 100).toFixed(2) : "" });
    const errorHost = h("div");

    const customHost = h("div", { class: "col gap-3" });
    if (customFields.length) {
      customHost.appendChild(h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Custom fields"));
      for (const definition of customFields) {
        const current = customer?.custom_fields?.[definition.key] ?? "";
        let control;
        if (definition.type === "select") {
          control = select({ value: current, options: [{ value: "", label: "—" }, ...definition.options.map((o) => ({ value: o, label: o }))] });
        } else if (definition.type === "textarea") {
          control = textarea({ value: current, rows: 2 });
        } else if (definition.type === "number") {
          control = textInput({ type: "number", value: current });
        } else if (definition.type === "date") {
          control = textInput({ type: "date", value: current });
        } else if (definition.type === "bool") {
          control = switchControl({ checked: Boolean(current), label: definition.label });
        } else {
          control = textInput({ value: current });
        }
        control.dataset.customKey = definition.key;
        customHost.appendChild(field({ label: definition.label, required: definition.required, control }));
      }
    }

    const submit = button(isEdit ? "Save changes" : "Add customer", { variant: "primary" });
    const instance = modal({
      title: isEdit ? `Edit ${customer.name}` : "New customer",
      size: "md",
      body: h("div", { class: "col gap-4" },
        errorHost,
        formGrid([
          field({ label: "Name", control: name, required: true }),
          field({ label: "Phone", control: phone, required: moduleConfig("customers").require_phone }),
          field({ label: "Email", control: email }),
          field({ label: "Tax number", control: taxNumber }),
        ]),
        field({ label: "Address", control: address }),
        moduleConfig("customers").allow_credit ? field({ label: "Credit limit", control: creditLimit, hint: "Leave 0 for no credit." }) : null,
        field({ label: "Notes", control: notes }),
        customHost),
      footer: [button("Cancel", { onClick: () => instance.close() }), submit],
    });

    submit.addEventListener("click", async () => {
      submit.setLoading(true);
      clear(errorHost);
      const customValues = {};
      customHost.querySelectorAll("[data-custom-key]").forEach((control) => {
        const key = control.dataset.customKey;
        if (control.type === "checkbox") customValues[key] = control.checked;
        else if (control.value !== "") customValues[key] = control.value;
      });
      const payload = {
        name: name.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        address: address.value.trim(),
        tax_number: taxNumber.value.trim(),
        notes: notes.value.trim(),
        custom_fields: customValues,
      };
      if (moduleConfig("customers").allow_credit) payload.credit_limit = creditLimit.value || "0";
      try {
        if (isEdit) {
          await patch(`/customers/${customer.id}`, payload);
          toast("Customer updated.", "success");
        } else {
          await post("/customers", payload);
          toast("Customer added.", "success");
        }
        instance.close();
        load();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
        submit.setLoading(false);
      }
    });
  }

  async function openCustomerDetail(customerId) {
    let data;
    try {
      data = await get(`/customers/${customerId}`);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    const customer = data.item;
    const body = h("div", { class: "col gap-4" });

    function render() {
      clear(body);
      body.appendChild(h("div", { class: "flex items-center gap-3" },
        avatar(customer.name, "#5b5bd6", "lg"),
        h("div", { class: "grow" },
          h("div", { class: "strong", style: { fontSize: "16px" } }, customer.name),
          h("div", { class: "tiny dim" }, [customer.phone, customer.email].filter(Boolean).join(" · ") || "No contact details"))));

      body.appendChild(h("div", { class: "grid grid--3" },
        miniKpi("Visits", number(customer.visits)),
        miniKpi("Lifetime spend", money(customer.total_spent_cents)),
        miniKpi("Points", number(customer.loyalty_points)),
        miniKpi("Store credit", money(customer.credit_balance_cents)),
        miniKpi("Credit limit", money(customer.credit_limit_cents)),
        miniKpi("Last visit", customer.last_visit_at ? date(customer.last_visit_at) : "Never")));

      body.appendChild(h("div", { class: "flex gap-2 wrap" },
        button("Adjust balance", { size: "sm", icon: "wallet", onClick: openBalanceModal }),
        button("Edit", { size: "sm", icon: "edit", onClick: () => openCustomerForm(customer) }),
        button("Delete", { size: "sm", variant: "ghost", danger: true, icon: "trash", onClick: removeCustomer })));

      if (Object.keys(customer.custom_fields || {}).length) {
        body.appendChild(kvList(Object.entries(customer.custom_fields).map(([key, value]) => [key, String(value)])));
      }
      if (customer.notes) body.appendChild(h("div", { class: "alert" }, customer.notes));

      body.appendChild(h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Purchase history"));
      body.appendChild(table({
        compact: true,
        rows: data.sales || [],
        onRowClick: (row) => openSaleDetail(row.id, { onChanged: () => load() }),
        empty: { icon: "receipt", title: "No purchases yet" },
        columns: [
          { key: "number", label: "Receipt", render: (row) => h("span", { class: "mono small" }, row.number) },
          { key: "created_at", label: "Date", render: (row) => date(row.created_at) },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
          { key: "total_cents", label: "Total", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.total_cents)) },
        ],
      }));
    }

    function miniKpi(label, value) {
      return h("div", { class: "card card--pad" },
        h("div", { class: "kpi__label", style: { fontSize: "10px" } }, label),
        h("div", { class: "strong", style: { fontSize: "16px", marginTop: "4px" } }, value));
    }

    function openBalanceModal() {
      const kind = select({ value: "credit", options: [{ value: "credit", label: "Store credit" }, { value: "loyalty", label: "Loyalty points" }] });
      const amount = textInput({ type: "number", step: "0.01", placeholder: "Use a minus sign to deduct" });
      const note = textInput({ placeholder: "Reason" });
      const errorHost = h("div");
      const instance = modal({
        title: "Adjust balance",
        subtitle: customer.name,
        size: "sm",
        body: h("div", { class: "col gap-3" }, errorHost, field({ label: "Type", control: kind }),
          field({ label: "Amount", control: amount, hint: "Negative values deduct." }), field({ label: "Note", control: note })),
        footer: [button("Cancel", { onClick: () => instance.close() }), button("Apply", { variant: "primary", onClick: async () => {
          try {
            await post(`/customers/${customer.id}/balance`, { kind: kind.value, amount: Number(amount.value) || 0, note: note.value.trim() });
            toast("Balance updated.", "success");
            instance.close();
            instanceDrawer.close();
            openCustomerDetail(customer.id);
            load();
          } catch (error) {
            clear(errorHost);
            errorHost.appendChild(alertBox(error.message, "danger"));
          }
        } })],
      });
    }

    async function removeCustomer() {
      const ok = await confirmDialog({
        title: `Delete ${customer.name}?`,
        message: "Their sales history stays, but the customer record is removed.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await del(`/customers/${customer.id}`);
      toast("Customer deleted.", "success");
      instanceDrawer.close();
      load();
    }

    render();
    const instanceDrawer = drawer({
      title: customer.name,
      subtitle: "Customer profile",
      size: "lg",
      body,
      footer: [button("Close", { onClick: () => instanceDrawer.close() })],
    });
  }

  load();
  return { el };
}
