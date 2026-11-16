/* Product catalog: list, editor, categories, stock and labels. */

import { h, clear, debounce } from "../core/dom.js";
import { icon, productIcon, PRODUCT_ICON_NAMES } from "../core/icons.js";
import { money, number, percent, qty as fmtQty } from "../core/fmt.js";
import { get, post, patch, del, downloadFile } from "../core/http.js";
import { hasPerm, moduleOn, moduleConfig, currency } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, pagination, badge, toast, emptyState, alertBox,
  field, textInput, textarea, select, switchControl, modal, confirmDialog, menu, formGrid, moneyInput,
  segmented, drawer, switchRow,
} from "../core/ui.js";

const EMOJI_CHOICES = ["☕", "🥐", "🍰", "🍕", "🍔", "🥗", "🧁", "🍫", "🥤", "🧊", "🫘", "🍵", "📦", "🎧", "🔌", "⌚", "📱", "💻", "🛠️", "🎁"];
const COLORS = ["#5b5bd6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#64748b"];

export default async function productsView(ctx) {
  const el = h("div");
  const filters = { q: "", category_id: "", department_id: "", low_stock: false, active: "1" };
  let page = 1;
  let meta = null;
  let categories = [];
  let departments = [];
  let taxes = [];
  let customFields = [];
  let knownProducts = [];

  const tableHost = h("div");
  const categoryChips = h("div", { class: "chips" });

  const searchInput = textInput({ placeholder: "Search name, SKU or barcode…", className: "input--sm" });
  searchInput.addEventListener("input", debounce(() => {
    filters.q = searchInput.value.trim();
    page = 1;
    load();
  }, 250));

  el.appendChild(pageHeader({
    title: "Products",
    subtitle: "Your catalog — prices, stock and everything customers see",
    actions: [
      button("Export", { icon: "download", onClick: async () => {
        await downloadFile("/products-export.csv");
        toast("Products exported.", "success");
      } }),
      button("Categories", { icon: "tag", onClick: openCategories }),
      button("Add product", { variant: "primary", icon: "plus", onClick: () => openProductForm() }),
    ],
  }));

  el.appendChild(sectionCard({
    title: "Catalog",
    flush: true,
    actions: h("div", { class: "flex gap-2" },
      h("div", { style: { width: "230px" } }, searchInput),
      button("Low stock", { size: "sm", icon: "layers", onClick: (e) => {
        filters.low_stock = !filters.low_stock;
        e.currentTarget.classList.toggle("btn--soft", filters.low_stock);
        page = 1;
        load();
      } }),
      button("Show archived", { size: "sm", variant: "ghost", onClick: (e) => {
        filters.active = filters.active === "1" ? "all" : "1";
        e.currentTarget.classList.toggle("btn--soft", filters.active === "all");
        page = 1;
        load();
      } })),
    body: h("div", {},
      h("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--border)" } }, categoryChips),
      tableHost),
  }));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const [products, categoryData, taxData] = await Promise.all([
        get("/products", {
          q: filters.q,
          category_id: filters.category_id,
          low_stock: filters.low_stock ? 1 : "",
          active: filters.active,
          page,
          per_page: 50,
        }),
        get("/categories"),
        get("/company/taxes"),
      ]);
      categories = categoryData.items;
      departments = categoryData.departments || [];
      taxes = taxData.items;
      customFields = products.custom_fields || [];
      knownProducts = products.items;
      meta = products.meta;
      renderChips();
      clear(tableHost);
      tableHost.appendChild(table({
        rows: products.items,
        onRowClick: (row) => openProductForm(row),
        empty: {
          icon: "box",
          title: "No products yet",
          text: "Add your first product to start selling.",
          action: button("Add product", { variant: "primary", icon: "plus", onClick: () => openProductForm() }),
        },
        columns: [
          {
            key: "name", label: "Product",
            render: (row) => h("div", { class: "flex items-center gap-2" },
              h("div", { class: "module-card__icon", style: { fontSize: "16px" } }, row.emoji || "📦"),
              h("div", { style: { minWidth: 0 } },
                h("div", { class: "strong truncate" }, row.name, row.is_featured ? h("span", { class: "dim" }, " ", icon("star")) : null),
                h("div", { class: "tiny dim" }, [row.sku, row.barcode].filter(Boolean).join(" · ") || "No SKU"))),
          },
          {
            key: "category", label: "Category",
            render: (row) => row.category
              ? h("span", { class: "chip", style: { borderColor: row.category_color } },
                h("span", { class: "chip__dot", style: { background: row.category_color } }), row.category)
              : h("span", { class: "dim" }, "—"),
          },
          { key: "price_cents", label: "Selling price", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.price_cents)) },
          { key: "cost_cents", label: "Buying price", align: "right", render: (row) => h("span", { class: "num dim" }, money(row.cost_cents)) },
          { key: "margin_percent", label: "Margin", align: "right", render: (row) => badge(`${percent(row.margin_percent, 0)}`, row.margin_percent >= 40 ? "success" : row.margin_percent >= 20 ? "warning" : "danger") },
          {
            key: "stock_qty", label: "Stock", align: "right",
            render: (row) => row.track_stock
              ? h("span", { class: `num ${row.is_low_stock ? "strong" : ""}`, style: row.is_low_stock ? { color: "var(--danger)" } : null }, fmtQty(row.stock_qty))
              : h("span", { class: "dim" }, "—"),
          },
          { key: "is_active", label: "Status", render: (row) => row.is_active ? badge("Active", "success") : badge("Archived") },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openProductForm(row) }),
              moduleOn("inventory")
                ? iconButton("layers", { size: "sm", variant: "ghost", title: "Adjust stock", onClick: () => openStockModal(row) })
                : null,
              iconButton("more", { size: "sm", variant: "ghost", title: "More", onClick: (e) => openRowMenu(e.currentTarget, row) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderChips() {
    clear(categoryChips);
    categoryChips.appendChild(h("button", {
      class: `chip${!filters.category_id ? " is-active" : ""}`,
      type: "button",
      onClick: () => { filters.category_id = ""; page = 1; load(); },
    }, "All categories"));
    for (const category of categories) {
      categoryChips.appendChild(h("button", {
        class: `chip${String(filters.category_id) === String(category.id) ? " is-active" : ""}`,
        type: "button",
        onClick: () => { filters.category_id = category.id; page = 1; load(); },
      }, h("span", { class: "chip__dot", style: { background: category.color } }), category.name,
      h("span", { class: "dim" }, ` ${category.product_count}`)));
    }
  }

  function openRowMenu(anchor, product) {
    menu(anchor, [
      { label: "Edit product", icon: "edit", onClick: () => openProductForm(product) },
      moduleOn("inventory") ? { label: "Adjust stock", icon: "layers", onClick: () => openStockModal(product) } : null,
      { label: "Print label", icon: "barcode", onClick: () => printLabel(product) },
      { label: "Duplicate", icon: "copy", onClick: () => openProductForm({ ...product, id: null, name: `${product.name} (copy)` }) },
      "-",
      {
        label: product.is_active ? "Archive" : "Restore",
        icon: product.is_active ? "x" : "check",
        danger: product.is_active,
        onClick: async () => {
          await patch(`/products/${product.id}`, { is_active: !product.is_active });
          toast(product.is_active ? "Product archived." : "Product restored.", "success");
          load();
        },
      },
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: `Delete ${product.name}?`,
            message: "Products with sales history are archived instead of deleted.",
            confirmLabel: "Delete",
            danger: true,
          });
          if (!confirmed) return;
          await del(`/products/${product.id}`);
          toast("Product removed.", "success");
          load();
        },
      },
    ].filter(Boolean));
  }

  /* --------------------------------------------------------------------- */
  /* Product editor                                                         */
  /* --------------------------------------------------------------------- */
  function openProductForm(product = null) {
    const isEdit = Boolean(product && product.id);
    const suggestionId = `product-suggestions-${Date.now()}`;
    const name = textInput({
      value: product?.name || "",
      placeholder: "Product name",
      attrs: { list: suggestionId },
    });
    const suggestions = h("datalist", { id: suggestionId },
      knownProducts.map((row) => h("option", { value: row.name }, row.sku || "")));
    const duplicateHint = h("div");
    name.addEventListener("input", () => {
      clear(duplicateHint);
      const term = name.value.trim().toLowerCase();
      if (!term) return;
      const match = knownProducts.find((row) => row.name.toLowerCase() === term && row.id !== product?.id);
      if (!match) return;
      duplicateHint.appendChild(alertBox(
        `${match.name} is already in the catalog (${fmtQty(match.stock_qty)} on hand). Use Receive stock in Inventory to add stock instead of creating a duplicate.`,
        "warning"));
    });
    const sku = textInput({ value: product?.sku || "", placeholder: "SKU-001" });
    const barcode = textInput({ value: product?.barcode || "", placeholder: "Scan or type a barcode" });
    const description = textarea({ value: product?.description || "", rows: 2 });
    const department = select({
      value: product?.department_id || "",
      options: [{ value: "", label: "No department" }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    });
    const category = select({
      value: product?.category_id || "",
      options: [{ value: "", label: "Uncategorised" }, ...categories
        .filter((c) => !department.value || String(c.department_id) === String(department.value))
        .map((c) => ({ value: c.id, label: c.name }))],
    });
    department.addEventListener("change", () => {
      const keep = category.value;
      clear(category);
      category.appendChild(h("option", { value: "" }, "Uncategorised"));
      for (const row of categories.filter((c) => !department.value || String(c.department_id) === String(department.value))) {
        category.appendChild(h("option", { value: row.id, selected: String(row.id) === String(keep) }, row.name));
      }
    });
    const tax = select({
      value: product?.tax_rate_id || "",
      options: [{ value: "", label: "No tax / use default" }, ...taxes.map((t) => ({ value: t.id, label: `${t.name} (${number(t.rate, 0)}%)` }))],
    });
    const price = moneyInput({ value: product ? (product.price_cents / 100).toFixed(2) : "" });
    const cost = moneyInput({ value: product ? (product.cost_cents / 100).toFixed(2) : "" });
    const unit = textInput({ value: product?.unit || "unit", placeholder: "unit / kg / hour" });
    const stock = textInput({ type: "number", value: product ? String(product.stock_qty) : "0", step: "0.001" });
    const threshold = textInput({ type: "number", value: String(product?.low_stock_threshold ?? 5), min: "0" });
    const iconHost = h("div", { class: "thumbs" });
    let chosenIcon = product?.icon || "box";
    const colorHost = h("div", { class: "thumbs" });
    let color = product?.color || COLORS[0];
    const trackStock = switchControl({ checked: product ? product.track_stock : true, label: "Track stock for this product" });
    const featured = switchControl({ checked: Boolean(product?.is_featured), label: "Feature on the till" });
    const active = switchControl({ checked: product ? product.is_active : true, label: "Active (sellable)" });
    const errorHost = h("div");

    for (const choice of PRODUCT_ICON_NAMES) {
      const btn = h("button", { class: `thumb${chosenIcon === choice ? " is-active" : ""}`, type: "button", title: choice, onClick: () => {
        chosenIcon = choice;
        [...iconHost.children].forEach((node) => node.classList.remove("is-active"));
        btn.classList.add("is-active");
      } }, productIcon(choice));
      iconHost.appendChild(btn);
    }
    for (const choice of COLORS) {
      const btn = h("button", {
        class: `thumb${color === choice ? " is-active" : ""}`,
        type: "button",
        style: { background: choice, color: "#fff" },
        onClick: () => {
          color = choice;
          [...colorHost.children].forEach((node) => node.classList.remove("is-active"));
          btn.classList.add("is-active");
        },
      }, "");
      colorHost.appendChild(btn);
    }

    const customHost = h("div", { class: "col gap-3" });
    if (customFields.length) {
      customHost.appendChild(h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Custom fields"));
      for (const definition of customFields) {
        const current = product?.custom_fields?.[definition.key] ?? "";
        let control;
        if (definition.type === "select") {
          control = select({ value: current, options: [{ value: "", label: "—" }, ...definition.options.map((option) => ({ value: option, label: option }))] });
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

    const stockFields = h("div", { class: "col gap-3" },
      formGrid([
        field({ label: "On hand", control: stock }),
        field({ label: "Low stock at", control: threshold }),
      ]));

    trackStock.input.addEventListener("change", () => {
      stockFields.style.opacity = trackStock.input.checked ? "1" : ".45";
      stock.disabled = !trackStock.input.checked;
    });
    if (!trackStock.input.checked) stockFields.style.opacity = ".45";

    const submit = button(isEdit ? "Save changes" : "Create product", { variant: "primary" });

    const body = h("div", { class: "col gap-4" },
      errorHost,
      duplicateHint,
      suggestions,
      formGrid([
        field({ label: "Name", control: name, required: true, id: "product-name" }),
        field({ label: "SKU", control: sku }),
        field({ label: "Barcode", control: barcode, hint: moduleOn("barcode") ? "Used when scanning at the till." : "" }),
        field({ label: "Department", control: department }),
        field({ label: "Category", control: category }),
        field({ label: "Selling price", control: price, required: true, hint: `What customers pay, in ${currency().code}` }),
        field({ label: "Buying price", control: cost, hint: "What you pay your supplier - used for profit." }),
        field({ label: "Tax rate", control: tax }),
        field({ label: "Unit", control: unit }),
      ]),
      field({ label: "Description", control: description }),
      h("div", { class: "form-grid" },
        field({ label: "Product icon", control: iconHost }),
        field({ label: "Tile colour", control: colorHost })),
      stockFields,
      h("div", { class: "col gap-2" }, trackStock, featured, active),
      customHost);

    const instance = modal({
      title: isEdit ? `Edit ${product.name}` : "New product",
      subtitle: isEdit ? "Changes apply to future sales" : "Add something you sell",
      size: "lg",
      body,
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
        sku: sku.value.trim(),
        barcode: barcode.value.trim(),
        description: description.value.trim(),
        department_id: department.value ? Number(department.value) : null,
        category_id: category.value ? Number(category.value) : null,
        tax_rate_id: tax.value ? Number(tax.value) : null,
        price: price.value,
        cost: cost.value,
        unit: unit.value.trim() || "unit",
        track_stock: trackStock.input.checked,
        stock_qty: Number(stock.value) || 0,
        low_stock_threshold: Number(threshold.value) || 0,
        color,
        icon: chosenIcon,
        is_active: active.input.checked,
        is_featured: featured.input.checked,
        custom_fields: customValues,
      };
      try {
        if (isEdit) {
          await patch(`/products/${product.id}`, payload);
          toast("Product updated.", "success");
        } else {
          await post("/products", payload);
          toast("Product created.", "success");
        }
        instance.close();
        load();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message + (Object.keys(error.fields || {}).length
          ? ` (${Object.values(error.fields).join(" ")})` : ""), "danger"));
        submit.setLoading(false);
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* Stock                                                                  */
  /* --------------------------------------------------------------------- */
  function openStockModal(product) {
    const mode = h("div", { class: "segmented" });
    let currentMode = "delta";
    const amount = moneyInput({ placeholder: "0" });
    amount.type = "number";
    amount.step = "0.001";
    const reason = select({
      value: "receive",
      options: [
        { value: "receive", label: "Receive stock" },
        { value: "wastage", label: "Wastage / breakage" },
        { value: "count", label: "Stock count correction" },
        { value: "return", label: "Customer return" },
        { value: "adjustment", label: "Other adjustment" },
      ],
    });
    const note = textInput({ placeholder: "e.g. Delivery from supplier" });
    const reference = textInput({ placeholder: "Invoice / reference" });
    const preview = h("div", { class: "change-due" }, h("span", {}, "New stock level"), h("span", { class: "num" }, fmtQty(product.stock_qty)));
    const errorHost = h("div");

    function setMode(next) {
      currentMode = next;
      clear(mode);
      for (const [value, label] of [["delta", "Add / remove"], ["set", "Set exact"]]) {
        mode.appendChild(h("button", {
          class: `segmented__item${currentMode === value ? " is-active" : ""}`,
          type: "button",
          onClick: () => setMode(value),
        }, label));
      }
      updatePreview();
    }

    function updatePreview() {
      const value = Number(amount.value) || 0;
      const next = currentMode === "set" ? value : Number(product.stock_qty) + value;
      preview.lastChild.textContent = fmtQty(next);
      preview.style.background = next < 0 ? "var(--danger-soft)" : "var(--surface-3)";
      preview.style.color = next < 0 ? "var(--danger)" : "var(--text)";
    }
    amount.addEventListener("input", updatePreview);
    setMode("delta");

    const instance = modal({
      title: "Adjust stock",
      subtitle: `${product.name} · ${fmtQty(product.stock_qty)} on hand`,
      size: "sm",
      body: h("div", { class: "col gap-3" },
        errorHost, mode,
        field({ label: currentMode === "delta" ? "Quantity (+/-)" : "New quantity", control: amount }),
        field({ label: "Reason", control: reason }),
        field({ label: "Note", control: note }),
        field({ label: "Reference", control: reference }),
        preview),
      footer: [button("Cancel", { onClick: () => instance.close() }),
        button("Apply", { variant: "primary", onClick: async () => {
          try {
            await post(`/products/${product.id}/stock`, {
              mode: currentMode,
              qty: Number(amount.value) || 0,
              reason: reason.value,
              note: note.value.trim(),
              reference: reference.value.trim(),
            });
            toast("Stock updated.", "success");
            instance.close();
            load();
          } catch (error) {
            clear(errorHost);
            errorHost.appendChild(alertBox(error.message, "danger"));
          }
        } })],
    });
  }

  function printLabel(product) {
    const win = window.open(`/api/products/${product.id}/label`, "_blank", "width=420,height=420");
    if (!win) toast("Allow pop-ups to print labels.", "warning");
  }

  /* --------------------------------------------------------------------- */
  /* Categories                                                             */
  /* --------------------------------------------------------------------- */
  function openCategories() {
    const list = h("div", { class: "col gap-2" });
    const nameInput = textInput({ placeholder: "New category name" });
    const colorInput = h("input", { type: "color", value: COLORS[0] });

    function render() {
      clear(list);
      for (const category of categories) {
        list.appendChild(h("div", { class: "flex items-center gap-2", style: { padding: "8px 0", borderBottom: "1px solid var(--border)" } },
          h("span", { class: "chip__dot", style: { background: category.color, width: "12px", height: "12px" } }),
          h("div", { class: "grow" }, h("div", { class: "strong small" }, category.name),
            h("div", { class: "tiny dim" }, `${category.product_count} products`)),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, onClick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${category.name}?`,
              message: "Products in this category become uncategorised.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            await del(`/categories/${category.id}`);
            toast("Category deleted.", "success");
            const data = await get("/categories");
            categories = data.items;
            render();
            load();
          } })));
      }
      if (!categories.length) list.appendChild(emptyState({ icon: "tag", title: "No categories yet" }));
    }

    const instance = modal({
      title: "Categories",
      subtitle: "Group products for faster selling",
      body: h("div", { class: "col gap-3" },
        list,
        h("div", { class: "flex gap-2 items-end" },
          field({ label: "New category", control: nameInput }),
          h("div", { class: "color-field" }, colorInput),
          button("Add", { variant: "primary", icon: "plus", onClick: async () => {
            if (!nameInput.value.trim()) return;
            try {
              await post("/categories", { name: nameInput.value.trim(), color: colorInput.value });
              nameInput.value = "";
              const data = await get("/categories");
              categories = data.items;
              render();
              load();
              toast("Category added.", "success");
            } catch (error) {
              toast(error.message, "error");
            }
          } })),
        ),
      footer: [button("Done", { variant: "primary", onClick: () => instance.close() })],
    });
    render();
  }

  load();
  return { el };
}
