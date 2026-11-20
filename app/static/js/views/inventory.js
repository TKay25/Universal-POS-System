/* Inventory: stock levels, movement ledger and suppliers. */

import { h, clear, debounce } from "../core/dom.js";
import { icon, productIcon } from "../core/icons.js";
import { money, qty as fmtQty, dateTime } from "../core/fmt.js";
import { get, post, patch, del, downloadFile } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig } from "../core/store.js";
import { pageHeader, sectionCard, button, iconButton, table, pagination, badge, toast, alertBox,
  field, textInput, select, modal, menu, statusBadge, formGrid, statCard, segmented, confirmDialog,
  fundingPicker,
  moneyInput, searchLoader } from "../core/ui.js";
import { openProductForm, openMoveProduct, openAdjustStock, openCategoriesManager,
  printProductLabel } from "./productForms.js";

export default async function inventoryView(ctx) {
  const el = h("div");
  const state = {
    tab: "levels", products: [], movements: [], suppliers: [], meta: null, movementMeta: null, funding: null,
    categories: [], departments: [], taxes: [], customFields: [], metaLoaded: false,
    loaded: false, search: "", from: "", to: "",
  };
  const canManageProducts = hasPerm("products.manage");
  const canManageStock = hasPerm("inventory.manage");
  const refresh = () => loadProducts();

  const catalogActions = [
    button("Export", { icon: "download", onClick: async () => {
      await downloadFile("/products-export.csv");
      toast("Products exported.", "success");
    } }),
    canManageProducts ? button("Categories", { icon: "tag", onClick: () => openCategoriesManager({
      departments: state.departments,
      onChanged: () => { state.metaLoaded = false; refresh(); },
    }) }) : null,
    canManageStock ? button("Bulk tools", { icon: "upload", onClick: openBulkModal }) : null,
    canManageProducts ? button("Add product", { variant: "primary", icon: "box", onClick: () => openCreateProduct() }) : null,
  ].filter(Boolean);

  el.appendChild(pageHeader({
    title: "Inventory",
    subtitle: "Every product you sell, what it cost and where it went",
    actions: catalogActions,
  }));

  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });
  const tabsHost = h("div");
  el.appendChild(kpiHost);
  el.appendChild(tabsHost);

  const searchInput = searchLoader(textInput({ placeholder: "Search products, SKU or department…", className: "input--sm" }));
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
    if (state.tab === "levels") tabsHost.appendChild(fundingCard());
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
    const cardActions = h("div", { class: "flex gap-2" },
      canManageStock ? button("Receive stock", { size: "sm", variant: "soft", icon: "plus", onClick: () => openReceiveModal() }) : null,
      button("Stock movements", { size: "sm", variant: "ghost", icon: "refresh", onClick: () => {
        state.tab = "movements";
        state.search = "";
        searchInput.value = "";
        render();
        loadMovements();
      } }));
    return sectionCard({
      title: "Stock levels",
      subtitle: `${rows.length}${rows.length === state.products.length ? "" : ` of ${state.products.length}`} active products`,
      flush: true,
      actions: cardActions,
      body: table({
        rows,
        empty: state.search
          ? { icon: "search", title: "Nothing matched", text: `No products match “${state.search}”.` }
          : { icon: "layers", title: "No products yet", text: "Add your first product to start selling.",
            action: canManageProducts ? button("Add product", { variant: "primary", icon: "plus", onClick: () => openCreateProduct() }) : null },
        columns: [
          { key: "name", label: "Product", render: (row) => h("div", { class: "flex items-center gap-2" },
            h("div", { class: "module-card__icon product-icon fs", style: { "--fs": "15px" } }, productIcon(row.icon)),
            h("div", {}, h("div", { class: "strong nowrap" }, row.name),
              h("div", { class: "tiny dim truncate", style: { maxWidth: "170px" } },
                row.sku || "—",
                row.category ? h("span", { class: "only-narrow" }, ` · ${row.category}`) : null))) },
          {
            key: "category", label: "Category", priority: "mid",
            render: (row) => h("div", { class: "col" },
              h("span", {}, row.category || h("span", { class: "dim" }, "—")),
              row.department ? h("span", { class: "tiny dim" }, row.department) : null),
          },
          { key: "stock_qty", label: "On hand", align: "right", render: (row) => row.track_stock ? h("span", { class: "strong num" }, fmtQty(row.stock_qty)) : h("span", { class: "dim" }, "untracked") },
          { key: "low_stock_threshold", label: "Low at", align: "right", priority: "low", render: (row) => row.track_stock ? fmtQty(row.low_stock_threshold) : "—" },
          { key: "cost_cents", label: "Cost", align: "right", priority: "low", render: (row) => money(row.cost_cents) },
          { key: "price_cents", label: "Price", align: "right", render: (row) => money(row.price_cents) },
          {
            key: "value", label: "Stock value", align: "right", priority: "low",
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
              canManageProducts
                ? iconButton("edit", { size: "sm", variant: "ghost", title: "Edit product", onClick: () => openEditProduct(row) })
                : null,
              canManageStock
                ? iconButton("plus", { size: "sm", variant: "ghost", title: "Add stock", onClick: () => openAdjustStock({ product: row, initialTab: "add", onSaved: refresh }) })
                : null,
              canManageStock
                ? iconButton("minus", { size: "sm", variant: "ghost", title: "Remove stock", onClick: () => openAdjustStock({ product: row, initialTab: "remove", onSaved: refresh }) })
                : null,
              iconButton("more", { size: "sm", variant: "ghost", title: "More", onClick: (event) => openProductMenu(event.currentTarget, row) })),
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
    const needsMeta = !state.metaLoaded;
    const [data, categoryData, taxData] = await Promise.all([
      get("/products", { per_page: 200, active: "1" }),
      needsMeta ? get("/categories").catch(() => ({ items: [], departments: [] })) : null,
      needsMeta ? get("/company/taxes").catch(() => ({ items: [] })) : null,
    ]);
    state.products = data.items;
    state.customFields = data.custom_fields || [];
    if (categoryData) {
      state.categories = categoryData.items || [];
      state.departments = categoryData.departments || [];
    }
    if (taxData) state.taxes = taxData.items || [];
    state.metaLoaded = Boolean(categoryData && taxData);
    state.loaded = true;
    await loadFunding();
    renderKpis();
    if (state.tab === "levels") render();
  }

  function productFormOptions(product = null) {
    return {
      product,
      categories: state.categories,
      departments: state.departments,
      taxes: state.taxes,
      customFields: state.customFields,
      knownProducts: state.products,
      onSaved: refresh,
      onPickExisting: (row) => openAdjustStock({ product: row, initialTab: "add", onSaved: refresh }),
    };
  }

  function openCreateProduct() {
    openProductForm(productFormOptions());
  }

  function openEditProduct(product) {
    openProductForm({ ...productFormOptions(product), onPickExisting: null });
  }

  function openProductMenu(anchor, product) {
    menu(anchor, [
      canManageProducts ? { label: "Edit product", icon: "edit", onClick: () => openEditProduct(product) } : null,
      canManageStock
        ? { label: "Add stock", icon: "plus", onClick: () => openAdjustStock({ product, initialTab: "add", onSaved: refresh }) }
        : null,
      canManageStock
        ? { label: "Remove stock", icon: "minus", onClick: () => openAdjustStock({ product, initialTab: "remove", onSaved: refresh }) }
        : null,
      canManageStock
        ? { label: "Set exact count", icon: "sliders", onClick: () => openAdjustStock({ product, initialTab: "set", onSaved: refresh }) }
        : null,
      canManageProducts
        ? { label: "Move to department / category", icon: "layers",
          onClick: () => openMoveProduct({ product, categories: state.categories, departments: state.departments, onSaved: refresh }) }
        : null,
      { label: "Print label", icon: "barcode", onClick: () => printProductLabel(product) },
      canManageProducts
        ? { label: "Duplicate", icon: "copy", onClick: () => openProductForm(productFormOptions({
          ...product, id: null, name: `${product.name} (copy)`, sku: "", barcode: "", stock_qty: 0 })) }
        : null,
      canManageProducts ? "-" : null,
      canManageProducts
        ? { label: product.is_active ? "Archive" : "Restore", icon: product.is_active ? "x" : "check", danger: product.is_active,
          onClick: async () => {
            await patch(`/products/${product.id}`, { is_active: !product.is_active });
            toast(product.is_active ? "Product archived." : "Product restored.", "success");
            refresh();
          } }
        : null,
      canManageProducts
        ? { label: "Delete", icon: "trash", danger: true, onClick: async () => {
          const confirmed = await confirmDialog({
            title: `Delete ${product.name}?`,
            message: "Products with sales history are archived instead of deleted.",
            confirmLabel: "Delete",
            danger: true,
          });
          if (!confirmed) return;
          await del(`/products/${product.id}`);
          toast("Product removed.", "success");
          refresh();
        } }
        : null,
    ].filter(Boolean));
  }

  async function loadFunding() {
    try {
      state.funding = await get("/inventory/funding");
    } catch {
      state.funding = null;
    }
  }

  function fundingCard() {
    const data = state.funding;
    if (!data || !data.total_cents) {
      return sectionCard({
        title: "Stock funding",
        subtitle: "Where the money for your shelves came from",
        body: h("div", { class: "col gap-2" },
          h("div", { class: "small muted" },
            "Next time you receive stock, say whether it was paid for with sales profit or external funds — the split shows up here.")),
      });
    }
    const bar = (row, tone) => h("div", { class: "col gap-1" },
      h("div", { class: "flex justify-between small" },
        h("span", {}, row.label),
        h("span", { class: "num strong" }, `${money(row.amount_cents)} · ${row.share_percent}%`)),
      h("div", { class: "progress" }, h("div", {
        class: `progress__bar${tone ? ` is-${tone}` : ""}`,
        style: { width: `${Math.max(2, row.share_percent)}%` },
      })));
    return sectionCard({
      title: "Stock funding",
      subtitle: `${money(data.total_cents)} of stock bought · ${data.profit.entries + data.external.entries} purchase${data.profit.entries + data.external.entries === 1 ? "" : "s"}`,
      actions: button("Record a purchase", {
        size: "sm",
        variant: "soft",
        icon: "plus",
        onClick: () => openReceiveModal(),
      }),
      body: h("div", { class: "col gap-3" },
        bar(data.profit, "success"),
        bar(data.external, "warning"),
        data.recent.length
          ? h("div", { class: "col gap-2 mt-2" },
            h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".09em", fontWeight: "650" } }, "Latest purchases"),
            data.recent.slice(0, 5).map((entry) => h("div", { class: "flex items-center gap-2" },
              h("div", { class: "grow", style: { minWidth: 0 } },
                h("div", { class: "small strong truncate" }, entry.product),
                h("div", { class: "tiny dim" },
                  `${dateTime(entry.created_at)}${entry.note ? ` · ${entry.note}` : ""}`)),
              badge(entry.label, entry.source === "profit" ? "success" : "warning"),
              h("span", { class: "num small strong" }, money(entry.amount_cents)))))
          : null)});
  }

  function renderKpis() {
    clear(kpiHost);
    const tracked = state.products.filter((product) => product.track_stock);
    const stockValue = tracked.reduce((sum, product) => sum + Math.round((product.stock_qty || 0) * (product.cost_cents || 0)), 0);
    const retailValue = tracked.reduce((sum, product) => sum + Math.round((product.stock_qty || 0) * (product.price_cents || 0)), 0);
    const low = tracked.filter((product) => product.is_low_stock).length;
    const out = tracked.filter((product) => product.stock_qty <= 0).length;
    kpiHost.appendChild(statCard({ compact: true, label: "Stock at cost", value: money(stockValue), icon: "cash", foot: `${tracked.length} tracked products` }));
    kpiHost.appendChild(statCard({ compact: true, label: "Retail value", value: money(retailValue), icon: "trend", foot: `Potential margin ${money(retailValue - stockValue)}`, tone: "success" }));
    kpiHost.appendChild(statCard({ compact: true, label: "Low stock", value: String(low), icon: "warn", foot: low ? "Reorder soon" : "All healthy", tone: low ? "warning" : "success" }));
    kpiHost.appendChild(statCard({ compact: true, label: "Out of stock", value: String(out), icon: "x", foot: out ? "Not sellable" : "All available", tone: out ? "danger" : "" }));
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
          {
            key: "funding",
            label: "Paid with",
            render: (row) => row.funding
              ? h("div", { class: "col" },
                badge(row.funding.label, row.funding.source === "profit" ? "success" : "warning"),
                h("span", { class: "tiny dim num" }, money(row.funding.amount_cents)))
              : h("span", { class: "dim" }, "—"),
          },
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


  function openReceiveModal(product = null) {
    const dataListId = `inventory-product-suggestions-${Date.now()}`;
    const suggestionList = h("datalist", { id: dataListId },
      state.products.map((row) => h("option", { value: row.name }, row.sku || "")));
    const search = textInput({
      placeholder: "Start typing a product name, SKU or barcode...",
      value: product?.name || "",
      attrs: { list: dataListId },
    });
    const productSelect = select({
      value: product?.id || "",
      options: state.products.map((row) => ({
        value: row.id,
        label: `${row.name}${row.sku ? ` / ${row.sku}` : ""} (${fmtQty(row.stock_qty)} on hand)`,
      })),
      placeholder: state.products.length ? "Choose a product" : "No products yet",
    });
    const quantity = textInput({ type: "number", step: "0.001", placeholder: "0" });
    const buyingPrice = moneyInput({ placeholder: "What you paid per unit", value: product?.cost_cents ? (product.cost_cents / 100).toFixed(2) : "" });
    const sellingPrice = moneyInput({ placeholder: "Optional - updates selling price" });
    const funding = fundingPicker({ required: true });
    const supplier = select({ value: "", options: [{ value: "", label: "No supplier" }] });
    const reference = textInput({ placeholder: "Invoice / delivery note" });
    const note = textInput({ placeholder: "e.g. Weekly coffee delivery" });
    const errorHost = h("div");

    const syncSelection = () => {
      const term = search.value.trim().toLowerCase();
      if (!term) return;
      const match = state.products.find((row) => (row.name || "").toLowerCase() === term
        || (row.sku || "").toLowerCase() === term
        || (row.barcode || "") === term);
      if (match) productSelect.value = String(match.id);
    };
    search.addEventListener("input", syncSelection);
    search.addEventListener("change", syncSelection);

    get("/company/suppliers").then((data) => {
      for (const row of data.items || []) supplier.appendChild(h("option", { value: row.id }, row.name));
    }).catch(() => {});

    async function submit() {
      clear(errorHost);
      const qty = Number(quantity.value) || 0;
      if (!productSelect.value) {
        errorHost.appendChild(alertBox("Choose the product this stock belongs to.", "danger"));
        productSelect.focus();
        return;
      }
      if (qty <= 0) {
        errorHost.appendChild(alertBox("Enter the quantity received.", "danger"));
        quantity.focus();
        return;
      }
      if (buyingPrice.value === "") {
        errorHost.appendChild(alertBox("Enter the buying price for this delivery.", "danger"));
        buyingPrice.focus();
        return;
      }
      if (!funding.value()) {
        errorHost.appendChild(alertBox("Tell us where the money came from - sales profit or external funds.", "danger"));
        funding.picker.focus();
        return;
      }
      try {
        await post(`/products/${productSelect.value}/stock`, {
          mode: "delta",
          qty,
          reason: "receive",
          supplier_id: supplier.value ? Number(supplier.value) : null,
          reference: reference.value.trim(),
          note: note.value.trim() || "Stock received",
          buying_price: buyingPrice.value,
          selling_price: sellingPrice.value !== "" ? sellingPrice.value : undefined,
          funding_source: funding.value(),
          funding_note: funding.noteValue(),
        });
        toast("Stock received.", "success");
        instance.close();
        await loadProducts();
        if (state.tab === "movements") loadMovements();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      }
    }

    const instance = modal({
      title: "Receive stock",
      subtitle: "Add a delivery to a product you already sell",
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Find product", control: search, hint: "Type a name, SKU or barcode - the match is selected for you." }),
        field({ label: "Product", control: productSelect, required: true }),
        formGrid([
          field({ label: "Quantity received", control: quantity, required: true }),
          field({ label: "Supplier", control: supplier }),
          field({ label: "Buying price", control: buyingPrice, required: true,
            hint: "What this delivery cost you - FIFO uses it for profit and stock value." }),
          field({ label: "Selling price (optional update)", control: sellingPrice }),
        ]),
        formGrid([field({ label: "Reference", control: reference }), field({ label: "Note", control: note })]),
        formGrid(funding.fields),
        h("div", { class: "flex items-center gap-2 small dim" },
          h("span", {}, "Selling something new?"),
          button("Create a product", { size: "sm", variant: "ghost", icon: "box", onClick: () => {
            instance.close();
            openCreateProduct();
          } })),
        suggestionList),
      footer: [button("Cancel", { onClick: () => instance.close() }),
        button("Receive stock", { variant: "primary", icon: "plus", onClick: submit })],
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
