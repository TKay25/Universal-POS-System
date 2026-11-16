/* Inventory: stock levels, movement ledger and suppliers. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, qty as fmtQty, dateTime } from "../core/fmt.js";
import { get, post, del } from "../core/http.js";
import { hasPerm, moduleOn } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, pagination, badge, toast, alertBox,
  field, textInput, select, modal, statusBadge, emptyState, formGrid, statCard, segmented, confirmDialog,
} from "../core/ui.js";

export default async function inventoryView(ctx) {
  const el = h("div");
  const state = { tab: "levels", products: [], movements: [], suppliers: [], meta: null, movementMeta: null };

  el.appendChild(pageHeader({
    title: "Inventory",
    subtitle: "What you have, what it is worth and where it went",
    actions: [
      button("Stock movements", { icon: "refresh", onClick: () => { state.tab = "movements"; render(); loadMovements(); } }),
      button("Add supplier", { icon: "truck", onClick: openSupplierModal }),
      button("Receive stock", { variant: "primary", icon: "plus", onClick: openReceiveModal }),
    ],
  }));

  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });
  const tabsHost = h("div");
  el.appendChild(kpiHost);
  el.appendChild(tabsHost);

  function render() {
    clear(tabsHost);
    tabsHost.appendChild(segmented([
      { value: "levels", label: "Stock levels", icon: "layers" },
      { value: "movements", label: "Movements", icon: "refresh" },
      ...(moduleOn("suppliers") ? [{ value: "suppliers", label: "Suppliers", icon: "truck" }] : []),
    ], {
      value: state.tab,
      onChange: (value) => {
        state.tab = value;
        render();
        if (value === "movements") loadMovements();
        if (value === "suppliers") loadSuppliers();
      },
    }));
    tabsHost.appendChild(h("div", { class: "mt-4" }));
    if (state.tab === "levels") tabsHost.appendChild(levelsCard());
    if (state.tab === "movements") tabsHost.appendChild(movementsCard());
    if (state.tab === "suppliers") tabsHost.appendChild(suppliersCard());
  }

  function levelsCard() {
    return sectionCard({
      title: "Stock levels",
      subtitle: `${state.products.length} active products`,
      flush: true,
      body: table({
        rows: state.products,
        empty: { icon: "layers", title: "No products to track", text: "Add products and enable stock tracking." },
        columns: [
          { key: "name", label: "Product", render: (row) => h("div", { class: "flex items-center gap-2" },
            h("div", { class: "module-card__icon", style: { fontSize: "15px" } }, row.emoji || "📦"),
            h("div", {}, h("div", { class: "strong" }, row.name), h("div", { class: "tiny dim" }, row.sku || "—"))) },
          { key: "category", label: "Category", render: (row) => row.category || h("span", { class: "dim" }, "—") },
          { key: "stock_qty", label: "On hand", align: "right", render: (row) => row.track_stock ? h("span", { class: "strong num" }, fmtQty(row.stock_qty)) : h("span", { class: "dim" }, "untracked") },
          { key: "low_stock_threshold", label: "Low at", align: "right", render: (row) => row.track_stock ? fmtQty(row.low_stock_threshold) : "—" },
          { key: "cost_cents", label: "Unit cost", align: "right", render: (row) => money(row.cost_cents) },
          {
            key: "value", label: "Stock value", align: "right",
            render: (row) => h("span", { class: "num" }, money(Math.round((row.stock_qty || 0) * (row.cost_cents || 0)))),
          },
          {
            key: "status", label: "Status",
            render: (row) => !row.track_stock
              ? badge("Not tracked")
              : row.stock_qty <= 0
                ? badge("Out of stock", "danger")
                : row.is_low_stock
                  ? badge("Low stock", "warning")
                  : badge("Healthy", "success"),
          },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              iconButton("plus", { size: "sm", variant: "ghost", title: "Receive stock", onClick: () => openReceiveModal(row) }),
              iconButton("edit", { size: "sm", variant: "ghost", title: "Adjust", onClick: () => openAdjustModal(row) })),
          },
        ],
      }),
    });
  }

  function movementsCard() {
    return sectionCard({
      title: "Stock movements",
      subtitle: "Every change with its reason and reference",
      flush: true,
      body: h("div", {}, movementTableHost),
    });
  }

  const movementTableHost = h("div");

  function suppliersCard() {
    return sectionCard({
      title: "Suppliers",
      subtitle: "Where your stock comes from",
      flush: true,
      actions: button("Add supplier", { size: "sm", variant: "soft", icon: "plus", onClick: openSupplierModal }),
      body: h("div", {}, supplierTableHost),
    });
  }

  const supplierTableHost = h("div");

  async function loadProducts() {
    const data = await get("/products", { per_page: 200, active: "1" });
    state.products = data.items;
    renderKpis();
    if (state.tab === "levels") render();
  }

  function renderKpis() {
    clear(kpiHost);
    const tracked = state.products.filter((product) => product.track_stock);
    const stockValue = tracked.reduce((sum, product) => sum + Math.round((product.stock_qty || 0) * (product.cost_cents || 0)), 0);
    const retailValue = tracked.reduce((sum, product) => sum + Math.round((product.stock_qty || 0) * (product.price_cents || 0)), 0);
    const low = tracked.filter((product) => product.is_low_stock).length;
    const out = tracked.filter((product) => product.stock_qty <= 0).length;
    kpiHost.appendChild(statCard({ label: "Stock at cost", value: money(stockValue), icon: "cash", foot: `${tracked.length} tracked products` }));
    kpiHost.appendChild(statCard({ label: "Retail value", value: money(retailValue), icon: "trend", foot: `Potential margin ${money(retailValue - stockValue)}`, tone: "success" }));
    kpiHost.appendChild(statCard({ label: "Low stock", value: String(low), icon: "warn", foot: low ? "Reorder soon" : "All healthy", tone: low ? "warning" : "success" }));
    kpiHost.appendChild(statCard({ label: "Out of stock", value: String(out), icon: "x", foot: out ? "Not sellable" : "All available", tone: out ? "danger" : "" }));
  }

  async function loadMovements() {
    clear(movementTableHost);
    movementTableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/stock-movements", { per_page: 50 });
      state.movements = data.items;
      state.movementMeta = data.meta;
      clear(movementTableHost);
      movementTableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "refresh", title: "No movements yet", text: "Stock changes appear here as you sell and receive." },
        columns: [
          { key: "created_at", label: "When", render: (row) => h("span", { class: "dim" }, dateTime(row.created_at)) },
          { key: "product", label: "Product", render: (row) => h("div", {}, h("div", { class: "strong" }, row.product), h("div", { class: "tiny dim" }, row.sku)) },
          { key: "reason", label: "Reason", render: (row) => statusBadge(row.reason) },
          {
            key: "qty_delta", label: "Change", align: "right",
            render: (row) => h("span", { class: "num strong", style: { color: row.qty_delta >= 0 ? "var(--success)" : "var(--danger)" } },
              `${row.qty_delta > 0 ? "+" : ""}${fmtQty(row.qty_delta)}`),
          },
          { key: "balance_after", label: "Balance", align: "right", render: (row) => h("span", { class: "num" }, fmtQty(row.balance_after)) },
          { key: "reference", label: "Reference", render: (row) => row.reference || h("span", { class: "dim" }, "—") },
          { key: "user", label: "By", render: (row) => h("span", { class: "dim" }, row.user) },
        ],
      }));
      movementTableHost.appendChild(pagination(data.meta, () => loadMovements()));
    } catch (error) {
      clear(movementTableHost);
      movementTableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  async function loadSuppliers() {
    clear(supplierTableHost);
    try {
      const data = await get("/company/suppliers");
      state.suppliers = data.items;
      clear(supplierTableHost);
      supplierTableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "truck", title: "No suppliers yet", text: "Add the businesses you buy from." },
        columns: [
          { key: "name", label: "Supplier", render: (row) => h("div", {}, h("div", { class: "strong" }, row.name), h("div", { class: "tiny dim" }, row.contact_name || "—")) },
          { key: "phone", label: "Phone" },
          { key: "email", label: "Email" },
          { key: "address", label: "Address", render: (row) => row.address || h("span", { class: "dim" }, "—") },
          {
            key: "actions", label: "", align: "right",
            render: (row) => iconButton("trash", { size: "sm", variant: "ghost", danger: true, onClick: async () => {
              const ok = await confirmDialog({ title: `Delete ${row.name}?`, message: "Past stock movements keep their reference.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              await del(`/company/suppliers/${row.id}`);
              toast("Supplier removed.", "success");
              loadSuppliers();
            } }),
          },
        ],
      }));
    } catch (error) {
      clear(supplierTableHost);
      supplierTableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function openAdjustModal(product) {
    const mode = { value: "delta" };
    const amount = textInput({ type: "number", step: "0.001", placeholder: "0" });
    const reason = select({
      value: "adjustment",
      options: [
        { value: "adjustment", label: "Manual adjustment" },
        { value: "count", label: "Stock count" },
        { value: "wastage", label: "Wastage" },
        { value: "correction", label: "Correction" },
      ],
    });
    const note = textInput({ placeholder: "Reason note" });
    const preview = h("div", { class: "change-due" }, h("span", {}, "New level"), h("span", { class: "num" }, fmtQty(product.stock_qty)));
    const errorHost = h("div");
    const modeSwitch = segmented([{ value: "delta", label: "Add / remove" }, { value: "set", label: "Set exact" }], {
      value: "delta",
      onChange: (value) => { mode.value = value; update(); },
    });
    function update() {
      const value = Number(amount.value) || 0;
      preview.lastChild.textContent = fmtQty(mode.value === "set" ? value : product.stock_qty + value);
    }
    amount.addEventListener("input", update);
    const instance = modal({
      title: "Adjust stock",
      subtitle: `${product.name} · ${fmtQty(product.stock_qty)} on hand`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, modeSwitch, field({ label: "Quantity", control: amount }),
        field({ label: "Reason", control: reason }), field({ label: "Note", control: note }), preview),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Apply", { variant: "primary", onClick: async () => {
        try {
          await post(`/products/${product.id}/stock`, {
            mode: mode.value,
            qty: Number(amount.value) || 0,
            reason: reason.value,
            note: note.value.trim(),
          });
          toast("Stock adjusted.", "success");
          instance.close();
          loadProducts();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function openReceiveModal(product = null) {
    const productSelect = select({
      value: product?.id || "",
      options: state.products.map((row) => ({ value: row.id, label: `${row.name} (${fmtQty(row.stock_qty)} on hand)` })),
      placeholder: "Choose a product",
    });
    const quantity = textInput({ type: "number", step: "0.001", placeholder: "0" });
    const supplier = select({
      value: "",
      options: [{ value: "", label: "No supplier" }, ...state.suppliers.map((row) => ({ value: row.id, label: row.name }))],
    });
    const reference = textInput({ placeholder: "Invoice / delivery note" });
    const note = textInput({ placeholder: "e.g. Weekly coffee delivery" });
    const errorHost = h("div");
    // Suppliers may not be loaded yet when opening from the levels tab.
    get("/company/suppliers").then((data) => {
      state.suppliers = data.items;
      clear(supplier);
      supplier.appendChild(h("option", { value: "" }, "No supplier"));
      for (const row of data.items) supplier.appendChild(h("option", { value: row.id }, row.name));
    }).catch(() => {});

    const instance = modal({
      title: "Receive stock",
      subtitle: "Bring new stock into the catalog",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Product", control: productSelect, required: true }),
        formGrid([
          field({ label: "Quantity", control: quantity, required: true }),
          field({ label: "Supplier", control: supplier }),
        ]),
        field({ label: "Reference", control: reference }),
        field({ label: "Note", control: note })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Receive", { variant: "primary", icon: "plus", onClick: async () => {
        if (!productSelect.value) {
          clear(errorHost);
          errorHost.appendChild(alertBox("Choose a product.", "danger"));
          return;
        }
        try {
          await post(`/products/${productSelect.value}/stock`, {
            mode: "delta",
            qty: Number(quantity.value) || 0,
            reason: "receive",
            supplier_id: supplier.value ? Number(supplier.value) : null,
            reference: reference.value.trim(),
            note: note.value.trim() || "Stock received",
          });
          toast("Stock received.", "success");
          instance.close();
          loadProducts();
          if (state.tab === "movements") loadMovements();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function openSupplierModal() {
    const name = textInput({ placeholder: "Supplier name" });
    const contact = textInput({ placeholder: "Contact person" });
    const phone = textInput({ placeholder: "+263 …" });
    const email = textInput({ type: "email", placeholder: "orders@supplier.com" });
    const address = textInput({ placeholder: "Address" });
    const errorHost = h("div");
    const instance = modal({
      title: "New supplier",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name, required: true }),
        formGrid([field({ label: "Contact", control: contact }), field({ label: "Phone", control: phone })]),
        field({ label: "Email", control: email }),
        field({ label: "Address", control: address })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Add supplier", { variant: "primary", onClick: async () => {
        try {
          await post("/company/suppliers", {
            name: name.value.trim(), contact_name: contact.value.trim(), phone: phone.value.trim(),
            email: email.value.trim(), address: address.value.trim(),
          });
          toast("Supplier added.", "success");
          instance.close();
          if (state.tab === "suppliers") loadSuppliers();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  render();
  loadProducts().catch((error) => {
    el.appendChild(alertBox(error.message, "danger"));
  });

  return { el };
}
