/* Inventory: stock levels, movement ledger and suppliers. */

import { h, clear } from "../core/dom.js";
import { icon, productIcon } from "../core/icons.js";
import { money, number, qty as fmtQty, dateTime } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig } from "../core/store.js";
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
          { key: "cost_cents", label: "Buying price", align: "right", render: (row) => money(row.cost_cents) },
          { key: "price_cents", label: "Selling price", align: "right", render: (row) => money(row.price_cents) },
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
    let mode = product ? "existing" : "existing";
    let departments = [];
    let categories = [];
    let products = [...state.products];
    const dataListId = `inventory-product-suggestions-${Date.now()}`;
    const suggestionList = h("datalist", { id: dataListId });

    const modeHost = h("div", { class: "segmented" });
    const existingHost = h("div", { class: "col gap-3" });
    const newHost = h("div", { class: "col gap-3 hidden" });

    const search = textInput({
      placeholder: "Start typing a product name, SKU or barcode…",
      value: product?.name || "",
      attrs: { list: dataListId },
    });
    const productSelect = select({
      value: product?.id || "",
      options: products.map((row) => ({
        value: row.id,
        label: `${row.name}${row.sku ? ` · ${row.sku}` : ""} (${fmtQty(row.stock_qty)} on hand)`,
      })),
      placeholder: products.length ? "Choose a product" : "No products yet - create one below",
    });
    const quantity = textInput({ type: "number", step: "0.001", placeholder: "0" });
    const buyingPrice = moneyInput({ placeholder: "Optional - updates buying price" });
    const sellingPrice = moneyInput({ placeholder: "Optional - updates selling price" });
    const supplier = select({ value: "", options: [{ value: "", label: "No supplier" }] });
    const reference = textInput({ placeholder: "Invoice / delivery note" });
    const note = textInput({ placeholder: "e.g. Weekly coffee delivery" });

    const newName = textInput({ placeholder: "Product name" });
    const newSku = textInput({ placeholder: "SKU" });
    const newBarcode = textInput({ placeholder: "Scan or type a barcode" });
    const newDepartment = select({ value: "", options: [{ value: "", label: "No department" }] });
    const newCategory = select({ value: "", options: [{ value: "", label: "No category" }] });
    const newBuying = moneyInput({ placeholder: "0.00" });
    const newSelling = moneyInput({ placeholder: "0.00" });
    const newQty = textInput({ type: "number", step: "0.001", value: "0" });
    const newThreshold = textInput({ type: "number", value: "5", min: "0" });
    const newUnit = textInput({ value: "unit" });

    const duplicateHint = h("div");
    const errorHost = h("div");

    function refreshSuggestions() {
      clear(suggestionList);
      for (const row of products) {
        suggestionList.appendChild(h("option", { value: row.name }, row.sku || ""));
      }
    }
    refreshSuggestions();

    async function loadMeta() {
      try {
        const [categoryData, supplierData] = await Promise.all([
          get("/categories"),
          get("/company/suppliers").catch(() => ({ items: [] })),
        ]);
        departments = categoryData.departments || [];
        categories = categoryData.items || [];
        clear(newDepartment);
        newDepartment.appendChild(h("option", { value: "" }, "No department"));
        for (const row of departments) newDepartment.appendChild(h("option", { value: row.id }, row.name));
        paintCategories();
        clear(supplier);
        supplier.appendChild(h("option", { value: "" }, "No supplier"));
        for (const row of supplierData.items || []) supplier.appendChild(h("option", { value: row.id }, row.name));
      } catch { /* non-fatal */ }
    }

    function paintCategories() {
      const keep = newCategory.value;
      clear(newCategory);
      newCategory.appendChild(h("option", { value: "" }, "No category"));
      const filtered = newDepartment.value
        ? categories.filter((row) => String(row.department_id) === String(newDepartment.value))
        : categories;
      for (const row of filtered) {
        newCategory.appendChild(h("option", { value: row.id, selected: String(row.id) === String(keep) }, row.name));
      }
    }
    newDepartment.addEventListener("change", paintCategories);

    function checkDuplicate() {
      clear(duplicateHint);
      const term = search.value.trim().toLowerCase();
      if (!term) return;
      const match = products.find((row) => row.name.toLowerCase() === term
        || (row.sku || "").toLowerCase() === term
        || (row.barcode || "") === term);
      if (!match) return;
      duplicateHint.appendChild(alertBox(
        h("div", { class: "col gap-1" },
          h("div", {}, h("strong", {}, `${match.name} is already in your catalog.`),
            ` ${fmtQty(match.stock_qty)} on hand${match.sku ? ` · ${match.sku}` : ""}. Add stock to it instead of creating a duplicate.`),
          button("Add stock to this product", {
            size: "sm",
            variant: "soft",
            icon: "plus",
            onClick: () => {
              mode = "existing";
              renderMode();
              productSelect.value = String(match.id);
              search.value = match.name;
              tooltipScroll();
            },
          })), "warning"));
    }
    function tooltipScroll() { /* keeps focus after mode switch */ }

    search.addEventListener("input", checkDuplicate);
    search.addEventListener("change", () => {
      const term = search.value.trim().toLowerCase();
      const match = products.find((row) => row.name.toLowerCase() === term
        || (row.sku || "").toLowerCase() === term
        || (row.barcode || "") === term);
      if (match) productSelect.value = String(match.id);
    });

    function renderMode() {
      clear(modeHost);
      for (const [value, label, iconName] of [
        ["existing", "Add to existing product", "plus"],
        ["new", "New product", "box"],
      ]) {
        modeHost.appendChild(h("button", {
          class: `segmented__item${mode === value ? " is-active" : ""}`,
          type: "button",
          onClick: () => {
            mode = value;
            renderMode();
          },
        }, icon(iconName), label));
      }
      existingHost.classList.toggle("hidden", mode !== "existing");
      newHost.classList.toggle("hidden", mode !== "new");
    }

    existingHost.appendChild(field({ label: "Find product", control: search }));
    existingHost.appendChild(field({ label: "Product", control: productSelect, required: true }));
    existingHost.appendChild(formGrid([
      field({ label: "Quantity received", control: quantity, required: true }),
      field({ label: "Supplier", control: supplier }),
      field({ label: "Buying price (optional update)", control: buyingPrice }),
      field({ label: "Selling price (optional update)", control: sellingPrice }),
    ]));
    existingHost.appendChild(formGrid([
      field({ label: "Reference", control: reference }),
      field({ label: "Note", control: note }),
    ]));

    newHost.appendChild(field({ label: "Product name", control: newName, required: true, hint: "Start typing - if it exists, we will offer to add stock instead." }));
    newHost.appendChild(formGrid([
      field({ label: "SKU", control: newSku }),
      field({ label: "Barcode", control: newBarcode }),
      field({ label: "Buying price", control: newBuying, required: true }),
      field({ label: "Selling price", control: newSelling, required: true }),
      field({ label: "Opening quantity", control: newQty }),
      field({ label: "Low stock at", control: newThreshold }),
      field({ label: "Department", control: newDepartment }),
      field({ label: "Category", control: newCategory }),
      field({ label: "Unit", control: newUnit }),
    ]));

    async function submit() {
      clear(errorHost);
      try {
        if (mode === "existing") {
          if (!productSelect.value) {
            errorHost.appendChild(alertBox("Choose a product or create a new one.", "danger"));
            return;
          }
          const qty = Number(quantity.value) || 0;
          if (qty <= 0) {
            errorHost.appendChild(alertBox("Enter the quantity received.", "danger"));
            return;
          }
          await post(`/products/${productSelect.value}/stock`, {
            mode: "delta",
            qty,
            reason: "receive",
            supplier_id: supplier.value ? Number(supplier.value) : null,
            reference: reference.value.trim(),
            note: note.value.trim() || "Stock received",
            buying_price: buyingPrice.value !== "" ? buyingPrice.value : undefined,
            selling_price: sellingPrice.value !== "" ? sellingPrice.value : undefined,
          });
          toast("Stock received.", "success");
        } else {
          if (!newName.value.trim() || newSelling.value === "") {
            errorHost.appendChild(alertBox("A new product needs a name and a selling price.", "danger"));
            return;
          }
          const { item } = await post("/products", {
            name: newName.value.trim(),
            sku: newSku.value.trim(),
            barcode: newBarcode.value.trim(),
            price: newSelling.value,
            cost: newBuying.value || "0",
            stock_qty: Number(newQty.value) || 0,
            low_stock_threshold: Number(newThreshold.value) || 0,
            department_id: newDepartment.value ? Number(newDepartment.value) : null,
            category_id: newCategory.value ? Number(newCategory.value) : null,
            unit: newUnit.value.trim() || "unit",
            icon: "box",
          });
          if (reference.value.trim()) {
            await patch(`/products/${item.id}`, {}).catch(() => {});
          }
          toast(`${item.name} added to the catalog.`, "success");
        }
        instance.close();
        await loadProducts();
        if (state.tab === "movements") loadMovements();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      }
    }

    renderMode();
    loadMeta();

    const instance = modal({
      title: "Receive stock",
      subtitle: "Bring new stock in, or add to something you already sell",
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost, modeHost, duplicateHint, existingHost, newHost, suggestionList),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Receive stock", { variant: "primary", icon: "plus", onClick: submit })],
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
