/* Inventory: stock levels, movement ledger and suppliers. */

import { h, clear, debounce } from "../core/dom.js";
import { icon, productIcon } from "../core/icons.js";
import { money, number, qty as fmtQty, dateTime } from "../core/fmt.js";
import { get, post, del, downloadFile } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, pagination, badge, toast, alertBox,
  field, textInput, select, modal, statusBadge, emptyState, formGrid, statCard, segmented, confirmDialog,
  moneyInput,
} from "../core/ui.js";

export default async function inventoryView(ctx) {
  const el = h("div");
  const state = {
    tab: "levels", products: [], movements: [], suppliers: [], meta: null, movementMeta: null,
    loaded: false, search: "", from: "", to: "",
  };

  el.appendChild(pageHeader({
    title: "Inventory",
    subtitle: "What you have, what it is worth and where it went",
    actions: [
      button("Stock movements", { icon: "refresh", onClick: () => { state.tab = "movements"; render(); loadMovements(); } }),
      hasPerm("settings.manage")
        ? button("Add supplier", { icon: "truck", onClick: openSupplierModal })
        : null,
      hasPerm("inventory.manage") ? button("Bulk tools", { icon: "download", onClick: openBulkModal }) : null,
      button("Receive stock", { variant: "primary", icon: "plus", onClick: openReceiveModal }),
    ].filter(Boolean),
  }));

  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });
  const tabsHost = h("div");
  el.appendChild(kpiHost);
  el.appendChild(tabsHost);

  const searchInput = textInput({ placeholder: "Search products, SKU or department…", className: "input--sm" });
  searchInput.value = state.search;
  const fromInput = h("input", { class: "input input--sm", type: "date", style: { width: "150px" } });
  const toInput = h("input", { class: "input input--sm", type: "date", style: { width: "150px" } });
  const dateGroup = h("div", { class: "flex gap-2 items-center" },
    h("span", { class: "report-toolbar__label" }, "From"), fromInput,
    h("span", { class: "report-toolbar__label" }, "To"), toInput);
  const filterBar = h("div", { class: "report-toolbar" },
    h("div", { class: "report-toolbar__group" }, searchInput),
    h("div", { class: "report-toolbar__group report-toolbar__group--end" }, dateGroup));

  function reloadActive() {
    if (state.tab === "levels") render();
    if (state.tab === "movements") loadMovements();
    if (state.tab === "suppliers") loadSuppliers();
  }

  searchInput.addEventListener("input", debounce(() => {
    state.search = searchInput.value.trim();
    reloadActive();
  }, 260));
  fromInput.addEventListener("change", () => { state.from = fromInput.value; loadMovements(); });
  toInput.addEventListener("change", () => { state.to = toInput.value; loadMovements(); });

  const SEARCH_HINTS = {
    levels: "Search products, SKU or department…",
    movements: "Search product, reference or reason…",
    suppliers: "Search supplier, contact or phone…",
  };

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
        state.search = "";
        searchInput.value = "";
        render();
        if (value === "movements") loadMovements();
        if (value === "suppliers") loadSuppliers();
      },
    }));
    searchInput.placeholder = SEARCH_HINTS[state.tab] || SEARCH_HINTS.levels;
    dateGroup.style.display = state.tab === "movements" ? "" : "none";
    tabsHost.appendChild(filterBar);
    tabsHost.appendChild(h("div", { class: "mt-4" }));
    if (state.tab === "levels" && !state.loaded) {
      tabsHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" }), h("span", {}, "Loading stock")));
      return;
    }
    if (state.tab === "levels") tabsHost.appendChild(levelsCard());
    if (state.tab === "movements") tabsHost.appendChild(movementsCard());
    if (state.tab === "suppliers") tabsHost.appendChild(suppliersCard());
  }

  function matches(row, fields) {
    const term = state.search.toLowerCase();
    if (!term) return true;
    return fields.some((field) => String(row[field] || "").toLowerCase().includes(term));
  }

  function levelsCard() {
    const rows = state.products.filter((row) => matches(row, ["name", "sku", "barcode", "category", "department"]));
    return sectionCard({
      title: "Stock levels",
      subtitle: `${rows.length}${rows.length === state.products.length ? "" : ` of ${state.products.length}`} active products`,
      flush: true,
      body: table({
        rows,
        empty: state.search
          ? { icon: "search", title: "Nothing matched", text: `No products match “${state.search}”.` }
          : { icon: "layers", title: "No products to track", text: "Add products and enable stock tracking." },
        columns: [
          { key: "name", label: "Product", render: (row) => h("div", { class: "flex items-center gap-2" },
            h("div", { class: "module-card__icon product-icon", style: { fontSize: "15px" } }, productIcon(row.icon)),
            h("div", {}, h("div", { class: "strong" }, row.name), h("div", { class: "tiny dim" }, row.sku || "—"))) },
          { key: "department", label: "Department", render: (row) => row.department
            ? h("span", { class: "small" }, row.department)
            : h("span", { class: "dim" }, "—") },
          { key: "category", label: "Category", render: (row) => row.category || h("span", { class: "dim" }, "—") },
          { key: "stock_qty", label: "On hand", align: "right", render: (row) => row.track_stock ? h("span", { class: "strong num" }, fmtQty(row.stock_qty)) : h("span", { class: "dim" }, "untracked") },
          { key: "low_stock_threshold", label: "Low at", align: "right", render: (row) => row.track_stock ? fmtQty(row.low_stock_threshold) : "—" },
          { key: "cost_cents", label: "Buying price", align: "right", render: (row) => money(row.cost_cents) },
          { key: "price_cents", label: "Selling price", align: "right", render: (row) => money(row.price_cents) },
          {
            key: "value", label: "Stock value (FIFO)", align: "right",
            render: (row) => h("span", {
              class: "num",
              title: "Oldest buying prices first — what the stock on the shelf actually cost",
            }, money(row.stock_value_cents ?? Math.round((row.stock_qty || 0) * (row.cost_cents || 0)))),
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
              iconButton("minus", { size: "sm", variant: "ghost", title: "Remove stock", onClick: () => openAdjustModal(row, { direction: -1 }) })),
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
    state.loaded = true;
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
      const query = { per_page: 50 };
      if (state.search) query.q = state.search;
      if (state.from) query.from = state.from;
      if (state.to) query.to = state.to;
      const data = await get("/stock-movements", query);
      state.movements = data.items;
      state.movementMeta = data.meta;
      clear(movementTableHost);
      movementTableHost.appendChild(table({
        rows: data.items,
        empty: state.search || state.from || state.to
          ? { icon: "search", title: "Nothing matched", text: "Try another search or a wider date range." }
          : { icon: "refresh", title: "No movements yet", text: "Stock changes appear here as you sell and receive." },
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
      const rows = (data.items || []).filter((row) => matches(row, ["name", "contact_name", "phone", "email", "address"]));
      state.suppliers = data.items;
      clear(supplierTableHost);
      supplierTableHost.appendChild(table({
        rows,
        empty: state.search
          ? { icon: "search", title: "Nothing matched", text: `No suppliers match “${state.search}”.` }
          : { icon: "truck", title: "No suppliers yet", text: "Add the businesses you buy from." },
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

  function openAdjustModal(product, { direction = 1, tab = "delta" } = {}) {
    const state = { tab, direction };
    const amount = textInput({ type: "number", step: "0.001", min: "0", placeholder: "0" });
    const counted = textInput({ type: "number", step: "0.001", min: "0", placeholder: fmtQty(product.stock_qty) });
    const deltaReason = select({
      value: "adjustment",
      options: [
        { value: "adjustment", label: "Manual adjustment" },
        { value: "wastage", label: "Wastage" },
        { value: "correction", label: "Correction" },
      ],
    });
    const setReason = select({
      value: "count",
      options: [
        { value: "count", label: "Stock count" },
        { value: "correction", label: "Correction" },
        { value: "adjustment", label: "Manual adjustment" },
      ],
    });
    const note = textInput({ placeholder: "Reason note" });
    const preview = h("div", { class: "change-due" }, h("span", {}, "New level"), h("span", { class: "num" }, fmtQty(product.stock_qty)));
    const errorHost = h("div");
    const fieldsHost = h("div", { class: "col gap-3" });
    const tabsRow = h("div", { class: "modal-tabs" });

    function currentQty() {
      if (state.tab === "set") return Number(counted.value) || 0;
      return product.stock_qty + state.direction * (Number(amount.value) || 0);
    }

    function addingStock() {
      return state.tab === "set"
        ? (Number(counted.value) || 0) > Number(product.stock_qty || 0)
        : state.direction > 0;
    }

    const buyingPrice = moneyInput({
      placeholder: "What you paid per unit",
      value: product.cost_cents ? (product.cost_cents / 100).toFixed(2) : "",
    });

    function update() {
      preview.lastChild.textContent = fmtQty(Math.round(currentQty() * 1000) / 1000);
      preview.lastChild.style.color = currentQty() < 0 ? "var(--danger)" : "";
    }

    function renderTabs() {
      clear(tabsRow);
      for (const tab of [
        { key: "delta", label: "Add / remove", icon: "plus" },
        { key: "set", label: "Set exact", icon: "sliders" },
      ]) {
        tabsRow.appendChild(h("button", {
          class: `modal-tab${state.tab === tab.key ? " is-active" : ""}`,
          type: "button",
          onClick: () => { state.tab = tab.key; renderTabs(); renderFields(); update(); },
        }, icon(tab.icon), h("span", {}, tab.label)));
      }
    }

    function renderFields() {
      clear(fieldsHost);
      if (state.tab === "delta") {
        const directionSwitch = segmented(
          [{ value: "1", label: "Add stock", icon: "plus" }, { value: "-1", label: "Remove stock", icon: "minus" }],
          {
            value: String(state.direction),
            onChange: (value) => { state.direction = Number(value); renderFields(); update(); },
          },
        );
        fieldsHost.append(
          directionSwitch,
          field({ label: "Quantity", control: amount, hint: "How many units to add or take out." }),
          state.direction > 0
            ? field({ label: "Buying price", control: buyingPrice, required: true,
              hint: "What this stock cost you — FIFO uses it for profit and stock value." })
            : null,
          field({ label: "Reason", control: deltaReason }),
          field({ label: "Note", control: note }),
        );
      } else {
        fieldsHost.append(
          field({ label: "Counted quantity", control: counted, hint: "What is physically on the shelf right now." }),
          addingStock()
            ? field({ label: "Buying price", control: buyingPrice, required: true,
              hint: "Used for the extra units this count adds (FIFO)." })
            : null,
          field({ label: "Reason", control: setReason }),
          field({ label: "Note", control: note }),
        );
      }
    }

    amount.addEventListener("input", update);
    counted.addEventListener("input", update);
    renderTabs();
    renderFields();

    const instance = modal({
      title: "Adjust stock",
      subtitle: `${product.name} · ${fmtQty(product.stock_qty)} on hand`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, tabsRow, fieldsHost, preview),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Apply", { variant: "primary", onClick: async (event) => {
        const trigger = event.currentTarget;
        trigger.setLoading(true);
        clear(errorHost);
        try {
          const qty = state.tab === "set"
            ? Number(counted.value) || 0
            : state.direction * (Number(amount.value) || 0);
          if (addingStock() && buyingPrice.value === "") {
            trigger.setLoading(false);
            errorHost.appendChild(alertBox("Enter the buying price for the stock you are adding.", "danger"));
            return;
          }
          await post(`/products/${product.id}/stock`, {
            mode: state.tab,
            qty,
            reason: state.tab === "set" ? setReason.value : deltaReason.value,
            note: note.value.trim(),
            buying_price: addingStock() ? buyingPrice.value : undefined,
          });
          toast("Stock adjusted.", "success");
          instance.close();
          loadProducts();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        } finally {
          trigger.setLoading(false);
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
    const buyingPrice = moneyInput({ placeholder: "What you paid per unit", value: product?.cost_cents ? (product.cost_cents / 100).toFixed(2) : "" });
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
      field({ label: "Buying price", control: buyingPrice, required: true,
        hint: "What this delivery cost you — FIFO uses it for profit and stock value." }),
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
          if (buyingPrice.value === "") {
            errorHost.appendChild(alertBox("Enter the buying price for this delivery.", "danger"));
            buyingPrice.focus();
            return;
          }
          await post(`/products/${productSelect.value}/stock`, {
            mode: "delta",
            qty,
            reason: "receive",
            supplier_id: supplier.value ? Number(supplier.value) : null,
            reference: reference.value.trim(),
            note: note.value.trim() || "Stock received",
            buying_price: buyingPrice.value,
            selling_price: sellingPrice.value !== "" ? sellingPrice.value : undefined,
          });
          toast("Stock received.", "success");
        } else {
          if (!newName.value.trim() || !newSelling.value) {
            errorHost.appendChild(alertBox("A new product needs a name and a selling price.", "danger"));
            return;
          }
          if (!newBuying.value) {
            errorHost.appendChild(alertBox("A new product needs its buying price.", "danger"));
            newBuying.focus();
            return;
          }
          const { item } = await post("/products", {
            name: newName.value.trim(),
            sku: newSku.value.trim(),
            barcode: newBarcode.value.trim(),
            price: newSelling.value,
            cost: newBuying.value,
            stock_qty: Number(newQty.value) || 0,
            low_stock_threshold: Number(newThreshold.value) || 0,
            department_id: newDepartment.value ? Number(newDepartment.value) : null,
            category_id: newCategory.value ? Number(newCategory.value) : null,
            unit: newUnit.value.trim() || "unit",
            icon: "box",
          });
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

  function openBulkModal() {
    let mode = "import";
    const modeHost = h("div", { class: "segmented" });
    const bodyHost = h("div", { class: "col gap-3" });
    const resultHost = h("div");
    const errorHost = h("div");

    const describe = {
      import: {
        title: "Bulk upload stock",
        blurb: "Download the Excel-friendly CSV template, fill it in and upload it. Existing SKUs/barcodes update; new ones are created.",
      },
      count: {
        title: "Stock count audit",
        blurb: "Download your catalogue with the system quantities, count what is on the shelf, then upload to audit and adjust.",
      },
    };

    function filePicker(onFile) {
      const input = h("input", { type: "file", accept: ".csv,text/csv", class: "input", style: { height: "auto", padding: "9px" } });
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (file) onFile(file);
      });
      return input;
    }

    function readFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("That file could not be read."));
        reader.readAsText(file);
      });
    }

    function renderMode() {
      clear(modeHost);
      modeHost.appendChild(segmented([
        { value: "import", label: "Upload new stock", icon: "upload" },
        { value: "count", label: "Count & audit", icon: "scan" },
      ], { value: mode, onChange: (value) => { mode = value; renderMode(); } }));

      clear(bodyHost);
      clear(resultHost);
      clear(errorHost);
      const copy = describe[mode];
      bodyHost.appendChild(h("div", { class: "alert alert--info" },
        icon("info"), h("span", {}, h("span", { class: "strong" }, copy.title), h("span", { class: "small" }, ` — ${copy.blurb}`))));

      const countNote = mode === "count" && moduleConfig("bulk_stock").count_requires_reason
        ? textInput({ placeholder: "Why is this count being applied?" })
        : null;
      if (countNote) {
        bodyHost.appendChild(field({
          label: "Count note",
          control: countNote,
          required: true,
          hint: "Saved on every stock movement created by this count.",
        }));
      }
      const currentNote = () => (countNote ? countNote.value.trim() : "");

      bodyHost.appendChild(h("div", { class: "flex gap-2 wrap" },
        button(mode === "import" ? "Download template" : "Download count sheet", {
          size: "sm", icon: "download",
          onClick: () => downloadFile("/inventory/template.csv", mode === "count" ? { mode: "count" } : {}).catch((error) => toast(error.message, "error")),
        }),
        mode === "count"
          ? button("Preview only (no changes)", { size: "sm", variant: "ghost", icon: "eye", onClick: () => uploadCount(false) })
          : null));

      const picker = filePicker(async (file) => {
        clear(errorHost);
        clear(resultHost);
        resultHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" }), h("span", {}, "Reading file")));
        try {
          const csv = await readFile(file);
          if (mode === "import") await uploadImport(csv);
          else await uploadCount(true, csv);
        } catch (error) {
          clear(resultHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      });
      bodyHost.appendChild(field({ label: "Filled CSV file", control: picker, hint: "Excel: File → Save as → CSV UTF-8." }));
      bodyHost.appendChild(errorHost);
      bodyHost.appendChild(resultHost);
    }

    async function uploadImport(csv) {
      const summary = await post("/inventory/import", { csv });
      clear(resultHost);
      resultHost.appendChild(h("div", { class: "card card--pad" },
        h("div", { class: "flex items-center gap-2 mb-2" }, icon("check"), h("span", { class: "strong" }, "Upload complete")),
        h("div", { class: "grid grid--kpi" },
          statCard({ label: "Created", value: String(summary.created), tone: "success" }),
          statCard({ label: "Updated", value: String(summary.updated) }),
          statCard({ label: "Stock adjusted", value: String(summary.stock_adjusted), tone: "accent" }),
          statCard({ label: "Rows skipped", value: String(summary.errors.length), tone: summary.errors.length ? "warning" : "" })),
        summary.errors.length
          ? h("div", { class: "col gap-1 mt-3" }, summary.errors.map((row) =>
            h("div", { class: "tiny", style: { color: "var(--warning)" } }, `Row ${row.row}: ${row.message}`)))
          : null));
      toast(`Imported ${summary.created} new and updated ${summary.updated} products.`, "success");
      await loadProducts();
      if (state.tab === "movements") loadMovements();
    }

    async function uploadCount(apply) {
      const input = bodyHost.querySelector('input[type="file"]');
      const file = input && input.files && input.files[0];
      if (!file) {
        toast("Choose a count sheet first.", "warning");
        return;
      }
      const csv = await readFile(file);
      const result = await post(`/inventory/count?apply=${apply ? 1 : 0}`, { csv, note: currentNote() });
      clear(resultHost);
      const host = h("div", { class: "card card--pad" },
        h("div", { class: "flex items-center gap-2 mb-2" },
          icon(result.mode === "applied" ? "check" : "eye"),
          h("span", { class: "strong" }, result.mode === "applied" ? "Count applied" : "Preview — nothing changed yet")),
        h("div", { class: "small dim mb-2" },
          `${result.variances.length} variance${result.variances.length === 1 ? "" : "s"} · value ${money(result.total_variance_value_cents)}`),
        table({
          rows: result.variances,
          columns: [
            { key: "name", label: "Product", render: (row) => h("span", { class: "strong" }, row.name) },
            { key: "sku", label: "SKU", render: (row) => h("span", { class: "dim mono tiny" }, row.sku || "—") },
            { key: "system_qty", label: "System", align: "right" },
            { key: "counted_qty", label: "Counted", align: "right" },
            { key: "variance", label: "Variance", align: "right", render: (row) => h("span", { class: "num strong", style: { color: row.variance < 0 ? "var(--danger)" : "var(--success)" } }, `${row.variance > 0 ? "+" : ""}${row.variance}`) },
            { key: "value_cents", label: "Value", align: "right", render: (row) => money(row.value_cents) },
          ],
          empty: { icon: "check", title: "No variances", text: "The count matches the system exactly." },
        }),
        result.errors.length
          ? h("div", { class: "col gap-1 mt-2" }, result.errors.map((row) => h("div", { class: "tiny", style: { color: "var(--warning)" } }, `Row ${row.row}: ${row.message}`)))
          : null);

      if (!apply && result.variances.length) {
        host.appendChild(h("div", { class: "flex gap-2 mt-3" },
          button("Apply these adjustments", {
            variant: "primary", icon: "check",
            onClick: async () => { await post(`/inventory/count?apply=1`, { csv, note: currentNote() }); toast("Stock count applied.", "success"); instance.close(); await loadProducts(); },
          })));
      }
      resultHost.appendChild(host);
      if (apply) {
        toast(`Applied ${result.applied} stock correction${result.applied === 1 ? "" : "s"}.`, "success");
        await loadProducts();
      }
    }

    renderMode();

    const instance = modal({
      title: "Bulk stock tools",
      subtitle: "Excel-friendly templates, bulk upload and stock-count audits",
      size: "lg",
      body: h("div", { class: "col gap-3" }, modeHost, bodyHost),
      footer: [button("Close", { onClick: () => instance.close() })],
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

  return {
    el,
    /* Stock changes elsewhere (sales, lay-bys) should be visible on return. */
    onActivate: () => {
      loadProducts();
      if (state.tab === "movements") loadMovements();
      if (state.tab === "suppliers") loadSuppliers();
    },
  };
}
