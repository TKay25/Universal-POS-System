/* Product editors shared by Inventory: catalog form, stock changes, re-filing and categories. */

import { h, clear, debounce } from "../core/dom.js";
import { icon, productIcon, PRODUCT_ICON_NAMES } from "../core/icons.js";
import { money, qty as fmtQty } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import { currency, moduleOn } from "../core/store.js";
import { requireBranchAction } from "../core/branch.js";
import { button, iconButton, field, textInput, textarea, select, switchControl, modal, confirmDialog,
  formGrid, moneyInput, fundingPicker, alertBox, emptyState, toast } from "../core/ui.js";
import { offerOfflineSave } from "../core/offlineUi.js";
import { newInStoreCode } from "../core/barcode.js";

const COLORS = ["#5b5bd6", "#22d3ee", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#64748b"];

export function printProductLabel(product) {
  const win = window.open(`/api/products/${product.id}/label`, "_blank", "width=420,height=420");
  if (!win) toast("Allow pop-ups to print labels.", "warning");
}

/* ------------------------------------------------------------------------- */
/* Catalog form                                                               */
/* ------------------------------------------------------------------------- */
export function openProductForm({
  product = null,
  categories = [],
  departments = [],
  taxes = [],
  customFields = [],
  knownProducts = [],
  onSaved = () => {},
  onPickExisting = null,
} = {}) {
  if (!requireBranchAction()) return;
  const isEdit = Boolean(product && product.id);
  let instance;
  const errorHost = h("div");
  const name = textInput({ value: product?.name || "", placeholder: "Start typing a product name", id: "product-name" });
  const matchesHost = h("div", { class: "combo__panel hidden" });

  function chooseExisting(row) {
    if (onPickExisting) {
      instance?.close();
      onPickExisting(row);
      return;
    }
    name.value = row.name;
    matchesHost.classList.add("hidden");
  }

  const renderMatches = () => {
    clear(matchesHost);
    const term = name.value.trim().toLowerCase();
    if (!term) {
      matchesHost.classList.add("hidden");
      return;
    }
    const matches = knownProducts
      .filter((row) => row.id !== product?.id)
      .filter((row) => (row.name || "").toLowerCase().includes(term)
        || (row.sku || "").toLowerCase().includes(term)
        || (row.barcode || "") === term)
      .slice(0, 6);
    if (!matches.length) {
      matchesHost.classList.add("hidden");
      return;
    }
    matchesHost.appendChild(h("div", { class: "combo__head" },
      onPickExisting ? "Already stocked - pick to add stock" : "Already stocked"));
    for (const row of matches) {
      const pick = h("button", { class: "combo__item", type: "button" },
        h("span", { class: "combo__icon product-icon" }, productIcon(row.icon)),
        h("span", { class: "combo__text" },
          h("span", { class: "strong truncate" }, row.name),
          h("span", { class: "tiny dim truncate" },
            [row.sku || "No SKU", `${fmtQty(row.stock_qty || 0)} on hand`, money(row.price_cents)].join(" · "))),
        h("span", { class: "combo__hint" }, onPickExisting ? "Add stock" : "Use name"));
      pick.addEventListener("mousedown", (event) => {
        event.preventDefault();
        chooseExisting(row);
      });
      matchesHost.appendChild(pick);
    }
    matchesHost.classList.remove("hidden");
  };
  name.addEventListener("input", debounce(renderMatches, 120));
  name.addEventListener("focus", renderMatches);
  name.addEventListener("blur", () => setTimeout(() => matchesHost.classList.add("hidden"), 140));

  const sku = textInput({ value: product?.sku || "", placeholder: "SKU-001" });
  const barcode = textInput({ value: product?.barcode || "", placeholder: "Scan or type a barcode" });
  const description = textarea({ value: product?.description || "", rows: 2 });
  const initialCategory = categories.find((c) => String(c.id) === String(product?.category_id || ""));
  const department = select({
    value: product?.department_id || initialCategory?.department_id || "",
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
  // New products start on the workspace's default rate (VAT 15.5% for a fresh
  // workspace); editing keeps whatever the product already uses.
  const defaultTax = taxes.find((t) => t.is_default);
  const tax = select({
    value: product ? (product.tax_rate_id || "") : (defaultTax ? String(defaultTax.id) : ""),
    options: [{ value: "", label: "No tax" }, ...taxes.map((t) => ({ value: t.id, label: `${t.name} (${Number(t.rate.toFixed(2))}%)` }))],
  });
  const price = moneyInput({ value: product ? (product.price_cents / 100).toFixed(2) : "" });
  const cost = moneyInput({ value: product ? (product.cost_cents / 100).toFixed(2) : "" });
  const unit = textInput({ value: product?.unit || "unit", placeholder: "unit / kg / hour" });
  const stock = textInput({ type: "number", value: product ? String(product.stock_qty) : "0", step: "0.001" });
  const threshold = textInput({ type: "number", value: String(product?.low_stock_threshold ?? 5), min: "0" });
  const funding = fundingPicker({ required: false });
  const originalStock = Number(product?.stock_qty || 0);
  const addsStock = () => Number(stock.value) > originalStock;
  const openingFundingHost = h("div", { class: "col gap-3" }, funding.fields);
  const updateOpeningFunding = () => {
    const shows = addsStock();
    openingFundingHost.classList.toggle("hidden", !shows);
    if (shows && !cost.value && product?.cost_cents) cost.value = (product.cost_cents / 100).toFixed(2);
  };
  stock.addEventListener("input", updateOpeningFunding);

  /* The tile look belongs to the category; a product only overrides it on demand. */
  let overridden = Boolean(product?.icon || product?.color);
  let chosenIcon = product?.icon || "box";
  let color = product?.color || COLORS[0];
  const tilePreview = h("div", { class: "tile-preview__tile" });
  const tileLabel = h("div", { class: "tile-preview__text" });
  const iconHost = h("div", { class: "thumbs" });
  const colorHost = h("div", { class: "thumbs" });
  const tilePicker = h("div", { class: "col gap-3 tile-picker hidden" },
    field({ label: "Product icon", control: iconHost }),
    field({ label: "Tile colour", control: colorHost }));
  const tileToggleLabel = h("span", {}, "Change tile");
  const tileToggle = button("", { size: "sm", variant: "ghost", icon: "palette",
    onClick: () => {
      const hidden = tilePicker.classList.toggle("hidden");
      tileToggleLabel.textContent = hidden ? "Change tile" : "Done";
    } });
  tileToggle.appendChild(tileToggleLabel);

  const selectedCategory = () => categories.find((row) => String(row.id) === String(category.value || ""));

  function paintTile() {
    const source = selectedCategory();
    const inherited = !overridden && Boolean(source);
    if (inherited) {
      color = source.color || color;
      chosenIcon = source.icon || chosenIcon;
    }
    tilePreview.style.background = `${color}1f`;
    tilePreview.style.color = color;
    clear(tilePreview);
    tilePreview.appendChild(productIcon(chosenIcon));
    clear(tileLabel);
    tileLabel.append(
      h("div", { class: "strong small" }, inherited ? source.name : "Custom tile"),
      h("div", { class: "tiny dim" }, inherited
        ? "Icon and colour follow this category"
        : "Set per product - pick a category to inherit instead"));
  }

  function markOverride() {
    overridden = true;
    paintTile();
  }

  function paintColors() {
    clear(colorHost);
    for (const choice of COLORS) {
      const btn = h("button", {
        class: `thumb${color === choice ? " is-active" : ""}`,
        type: "button",
        style: { background: choice, color: "#fff" },
        onClick: () => { color = choice; markOverride(); paintColors(); tilePickerRefresh(); },
      }, color === choice ? icon("check") : "");
      colorHost.appendChild(btn);
    }
  }
  function paintIcons() {
    clear(iconHost);
    for (const choice of PRODUCT_ICON_NAMES) {
      const btn = h("button", {
        class: `thumb${chosenIcon === choice ? " is-active" : ""}`,
        type: "button",
        title: choice,
        onClick: () => { chosenIcon = choice; markOverride(); paintIcons(); tilePickerRefresh(); },
      }, productIcon(choice));
      iconHost.appendChild(btn);
    }
  }
  function tilePickerRefresh() { paintColors(); paintIcons(); }

  category.addEventListener("change", () => {
    overridden = false;
    paintTile();
    tilePickerRefresh();
  });
  paintTile();
  tilePickerRefresh();

  const trackStock = switchControl({ checked: product ? product.track_stock : true, label: "Track stock for this product" });
  const featured = switchControl({ checked: Boolean(product?.is_featured), label: "Feature on the till" });
  const active = switchControl({ checked: product ? product.is_active : true, label: "Active (sellable)" });

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
    ]),
    openingFundingHost);

  trackStock.input.addEventListener("change", () => {
    stockFields.style.opacity = trackStock.input.checked ? "1" : ".45";
    stock.disabled = !trackStock.input.checked;
    updateOpeningFunding();
  });
  if (!trackStock.input.checked) stockFields.style.opacity = ".45";
  updateOpeningFunding();

  const submit = button(isEdit ? "Save changes" : "Create product", { variant: "primary", icon: isEdit ? "check" : "plus" });

  const body = h("div", { class: "col gap-4" },
    errorHost,
    formGrid([
      h("div", { class: "combo" },
        field({ label: "Name", control: name, required: true, id: "product-name",
          hint: isEdit ? "" : "Existing products appear as you type - pick one to add stock instead." }),
        matchesHost),
      field({ label: "SKU", control: sku }),
      field({
        label: "Barcode",
        control: h("div", { class: "field-with-action" },
          barcode,
          moduleOn("barcode")
            ? button("Make code", {
              size: "sm",
              variant: "ghost",
              icon: "barcode",
              title: "Create an in-store EAN-13 barcode",
              onClick: () => {
                barcode.value = newInStoreCode(knownProducts.map((row) => row.barcode).filter(Boolean));
                barcode.focus();
                barcode.select?.();
                toast("Barcode created — print a label from the Barcode studio.", "info");
              },
            })
            : null),
        hint: moduleOn("barcode") ? "Scanned at the till. Leave it blank to mint one later." : "",
      }),
      field({ label: "Department", control: department }),
      field({ label: "Category", control: category }),
      field({ label: "Selling price", control: price, required: true, hint: `What customers pay, in ${currency().code}` }),
      field({ label: "Buying price", control: cost, hint: "What you pay your supplier - used for profit." }),
      field({ label: "Tax rate", control: tax }),
      field({ label: "Unit", control: unit }),
    ]),
    field({ label: "Description", control: description }),
    h("div", { class: "tile-preview" },
      tilePreview,
      tileLabel,
      h("div", { class: "tile-preview__action" }, tileToggle)),
    tilePicker,
    stockFields,
    h("div", { class: "col gap-2" }, trackStock, featured, active),
    customHost);

  instance = modal({
    title: isEdit ? `Edit ${product.name}` : "New product",
    subtitle: isEdit ? "Changes apply to future sales" : "Add something you sell",
    size: "lg",
    body,
    footer: [button("Cancel", { onClick: () => instance.close() }), submit],
  });

  submit.addEventListener("click", async () => {
    submit.setLoading(true);
    clear(errorHost);
    const addingStock = trackStock.input.checked && addsStock();
    if (addingStock && !funding.value()) {
      errorHost.appendChild(alertBox("Say where the money for this stock came from - sales profit or external funds.", "danger"));
      funding.picker.focus();
      submit.setLoading(false);
      return;
    }
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
      funding_source: addingStock ? funding.value() : undefined,
      funding_note: addingStock ? funding.noteValue() : undefined,
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
      onSaved();
    } catch (error) {
      errorHost.appendChild(alertBox(error.message + (Object.keys(error.fields || {}).length
        ? ` (${Object.values(error.fields).join(" ")})` : ""), "danger"));
      submit.setLoading(false);
    }
  });
}

/* ------------------------------------------------------------------------- */
/* Re-file a product between departments / categories                        */
/* ------------------------------------------------------------------------- */
export function openMoveProduct({ product, categories = [], departments = [], onSaved = () => {} } = {}) {
  if (!requireBranchAction()) return;
  const currentCategory = categories.find((c) => String(c.id) === String(product.category_id || ""));
  const department = select({
    value: product.department_id || currentCategory?.department_id || "",
    options: [{ value: "", label: "No department" }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
  });
  const category = select({ value: product.category_id || "", options: [] });
  const errorHost = h("div");

  const fillCategories = (keep) => {
    clear(category);
    category.appendChild(h("option", { value: "" }, "Uncategorised"));
    for (const row of categories.filter((c) => !department.value || String(c.department_id) === String(department.value))) {
      category.appendChild(h("option", { value: row.id, selected: String(row.id) === String(keep) }, row.name));
    }
  };
  fillCategories(product.category_id || "");
  department.addEventListener("change", () => fillCategories(""));

  const submit = button("Move product", { variant: "primary", icon: "check" });
  const instance = modal({
    title: `Move ${product.name}`,
    subtitle: "Re-filing is instant - sales history keeps its original prices",
    size: "sm",
    body: h("div", { class: "col gap-3" }, errorHost,
      field({ label: "Department", control: department }),
      field({ label: "Category", control: category, hint: "Only categories in the chosen department are listed." })),
    footer: [button("Cancel", { onClick: () => instance.close() }), submit],
  });

  submit.addEventListener("click", async () => {
    submit.setLoading(true);
    clear(errorHost);
    const chosenCategory = categories.find((c) => String(c.id) === String(category.value || ""));
    try {
      await patch(`/products/${product.id}`, {
        department_id: department.value ? Number(department.value) : (chosenCategory?.department_id || null),
        category_id: category.value ? Number(category.value) : null,
      });
      toast(`${product.name} moved.`, "success");
      instance.close();
      onSaved();
    } catch (error) {
      errorHost.appendChild(alertBox(error.message, "danger"));
      submit.setLoading(false);
    }
  });
}

/* ------------------------------------------------------------------------- */
/* Stock changes - add, remove and count are separate tabs                    */
/* ------------------------------------------------------------------------- */
const STOCK_TABS = [
  { key: "add", label: "Add stock", icon: "plus" },
  { key: "remove", label: "Remove stock", icon: "minus" },
  { key: "set", label: "Set exact", icon: "sliders" },
];

const ADD_REASONS = [
  { value: "receive", label: "Received from supplier" },
  { value: "return", label: "Customer return" },
  { value: "transfer", label: "Branch transfer in" },
  { value: "adjustment", label: "Other addition" },
];

const REMOVE_REASONS = [
  { value: "wastage", label: "Wastage / breakage" },
  { value: "return", label: "Returned to supplier" },
  { value: "correction", label: "Correction" },
  { value: "adjustment", label: "Other reduction" },
];

const SET_REASONS = [
  { value: "count", label: "Stock count" },
  { value: "correction", label: "Correction" },
  { value: "adjustment", label: "Manual adjustment" },
];

export function openAdjustStock({ product, initialTab = "add", onSaved = () => {} } = {}) {
  if (!requireBranchAction()) return;
  const onHand = Number(product.stock_qty || 0);
  const state = { tab: STOCK_TABS.some((row) => row.key === initialTab) ? initialTab : "add" };
  const quantity = textInput({ type: "number", step: "0.001", min: "0", placeholder: "0" });
  const counted = textInput({ type: "number", step: "0.001", min: "0", placeholder: fmtQty(onHand) });
  const buyingPrice = moneyInput({
    placeholder: "What you paid per unit",
    value: product.cost_cents ? (product.cost_cents / 100).toFixed(2) : "",
  });
  const funding = fundingPicker({ required: false });
  const note = textInput({ placeholder: "e.g. Delivery from supplier" });
  const reference = textInput({ placeholder: "Invoice / reference" });
  const preview = h("div", { class: "change-due" },
    h("span", {}, "New level"), h("span", { class: "num" }, fmtQty(onHand)));
  const errorHost = h("div");
  const tabsRow = h("div", { class: "modal-tabs" });
  const fieldsHost = h("div", { class: "col gap-3" });
  const fundingHost = h("div", { class: "col gap-3" }, funding.fields);
  const addReason = select({ value: "receive", options: ADD_REASONS });
  const removeReason = select({ value: "wastage", options: REMOVE_REASONS });
  const setReason = select({ value: "count", options: SET_REASONS });
  const buyingPriceField = (hint) => field({ label: "Buying price", control: buyingPrice, required: true, hint });
  let priceBlock = null;

  const entering = () => (state.tab === "set" ? (Number(counted.value) || 0) : (Number(quantity.value) || 0));
  const addingStock = () => (state.tab === "set" ? entering() > onHand : state.tab === "add");
  const nextLevel = () => {
    if (state.tab === "set") return entering();
    if (state.tab === "add") return onHand + entering();
    return onHand - entering();
  };

  function updatePreview() {
    const next = Math.round(nextLevel() * 1000) / 1000;
    preview.lastChild.textContent = fmtQty(next);
    preview.lastChild.style.color = next < 0 ? "var(--danger)" : "";
    preview.style.background = next < 0 ? "var(--danger-soft)" : "var(--surface-3)";
    if (priceBlock) priceBlock.classList.toggle("hidden", !addingStock());
    if (addingStock() && !buyingPrice.value && product.cost_cents) {
      buyingPrice.value = (product.cost_cents / 100).toFixed(2);
    }
  }

  function renderTabs() {
    clear(tabsRow);
    for (const tab of STOCK_TABS) {
      tabsRow.appendChild(h("button", {
        class: `modal-tab${state.tab === tab.key ? " is-active" : ""}`,
        type: "button",
        onClick: () => { state.tab = tab.key; renderTabs(); renderFields(); },
      }, icon(tab.icon), h("span", {}, tab.label)));
    }
  }

  function renderFields() {
    clear(fieldsHost);
    priceBlock = null;
    if (state.tab === "add") {
      note.placeholder = "e.g. Delivery from supplier";
      priceBlock = h("div", { class: "col gap-3" },
        formGrid([buyingPriceField("What this stock cost you - FIFO uses it for profit and stock value."),
          field({ label: "Reference", control: reference })]),
        fundingHost);
      fieldsHost.append(
        field({ label: "Quantity received", control: quantity, required: true, hint: "How many units arrived." }),
        priceBlock,
        field({ label: "Note", control: note, required: true, hint: "Shown on the stock ledger, e.g. supplier name." }),
        field({ label: "Source", control: addReason }),
      );
    } else if (state.tab === "remove") {
      note.placeholder = "e.g. Dropped tray, expired stock";
      fieldsHost.append(
        field({ label: "Quantity to remove", control: quantity, required: true,
          hint: `Cannot be more than the ${fmtQty(onHand)} on hand.` }),
        formGrid([field({ label: "Reason", control: removeReason }),
          field({ label: "Reference", control: reference })]),
        field({ label: "Note", control: note, required: true, hint: "What happened to this stock?" }),
      );
    } else {
      note.placeholder = "Optional note about this count";
      priceBlock = h("div", { class: "col gap-3" },
        formGrid([buyingPriceField("FIFO values the extra units this count adds."),
          field({ label: "Reference", control: reference })]),
        fundingHost);
      fieldsHost.append(
        field({ label: "Counted quantity", control: counted, required: true,
          hint: "What is physically on the shelf right now." }),
        priceBlock,
        field({ label: "Reason", control: setReason }),
        field({ label: "Note", control: note, hint: "Optional - why the count differs." }),
      );
    }
    updatePreview();
  }

  const reasonValue = () => (state.tab === "add" ? addReason.value : state.tab === "remove" ? removeReason.value : setReason.value);
  quantity.addEventListener("input", updatePreview);
  counted.addEventListener("input", updatePreview);

  const instance = modal({
    title: "Change stock",
    subtitle: `${product.name} - ${fmtQty(onHand)} on hand`,
    size: "sm",
    body: h("div", { class: "col gap-3" }, errorHost, tabsRow, fieldsHost, preview),
    footer: [button("Cancel", { onClick: () => instance.close() }), button("Apply", { variant: "primary", icon: "check", onClick: async (event) => {
      const trigger = event.currentTarget;
      clear(errorHost);
      const amount = entering();
      if (state.tab === "remove") {
        if (amount <= 0) {
          errorHost.appendChild(alertBox("Enter how many units to remove.", "danger"));
          return;
        }
        if (amount > onHand) {
          errorHost.appendChild(alertBox(`Only ${fmtQty(onHand)} on hand. Remove less, or use Set exact.`, "danger"));
          return;
        }
      }
      if (entering() <= 0 && state.tab !== "set") {
        errorHost.appendChild(alertBox("Enter a quantity greater than zero.", "danger"));
        return;
      }
      if (state.tab === "add" && !note.value.trim()) {
        errorHost.appendChild(alertBox("Add a short note for this delivery.", "danger"));
        note.focus();
        return;
      }
      if (state.tab === "remove" && reasonValue() === "wastage" && !note.value.trim()) {
        errorHost.appendChild(alertBox("Say what happened to the stock being written off.", "danger"));
        note.focus();
        return;
      }
      if (addingStock() && buyingPrice.value === "") {
        errorHost.appendChild(alertBox("Enter the buying price for the stock you are adding.", "danger"));
        buyingPrice.focus();
        return;
      }
      if (addingStock() && !funding.value()) {
        errorHost.appendChild(alertBox("Tell us where the money came from - sales profit or external funds.", "danger"));
        funding.picker.focus();
        return;
      }
      const stockPayload = {
        mode: state.tab === "set" ? "set" : "delta",
        qty: state.tab === "remove" ? -amount : amount,
        reason: reasonValue(),
        note: note.value.trim(),
        reference: reference.value.trim(),
        buying_price: addingStock() ? buyingPrice.value : undefined,
        funding_source: addingStock() ? funding.value() : undefined,
        funding_note: addingStock() ? funding.noteValue() : undefined,
      };
      trigger.setLoading(true);
      try {
        await post(`/products/${product.id}/stock`, stockPayload);
        toast(state.tab === "remove" ? "Stock removed." : "Stock updated.", "success");
        instance.close();
        onSaved();
      } catch (error) {
        if (error.code === "network" && await offerOfflineSave({
          path: `/products/${product.id}/stock`,
          body: stockPayload,
          label: `Stock ${state.tab} · ${product.name}`,
        })) {
          instance.close();
          return;
        }
        clear(errorHost);
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        trigger.setLoading(false);
      }
    } })],
  });

  renderTabs();
  renderFields();
  updatePreview();
}

/* ------------------------------------------------------------------------- */
/* Categories                                                                 */
/* ------------------------------------------------------------------------- */
export function openCategoryEditor({
  category = null,
  departments = [],
  defaultDepartmentId = "",
  defaultColor = "",
  onSaved = () => {},
} = {}) {
  if (!requireBranchAction()) return;
  const isEdit = Boolean(category && category.id);
  const name = textInput({ value: category?.name || "", placeholder: "e.g. TVs" });
  const department = select({
    value: category?.department_id || defaultDepartmentId || "",
    options: [{ value: "", label: "No department" }, ...departments.map((row) => ({ value: row.id, label: row.name }))],
  });
  const active = switchControl({ checked: category ? category.is_active : true, label: "Active (visible on the till)" });
  let color = category?.color || defaultColor || COLORS[0];
  let chosenIcon = category?.icon || "tag";
  const preview = h("div", { class: "tile-preview__tile" });
  const colorHost = h("div", { class: "thumbs" });
  const iconHost = h("div", { class: "thumbs" });
  const errorHost = h("div");

  function paintPreview() {
    preview.style.background = `${color}1f`;
    preview.style.color = color;
    clear(preview);
    preview.appendChild(productIcon(chosenIcon));
  }
  function paintColors() {
    clear(colorHost);
    for (const choice of COLORS) {
      const btn = h("button", {
        class: `thumb${color === choice ? " is-active" : ""}`,
        type: "button",
        style: { background: choice, color: "#fff" },
        onClick: () => { color = choice; paintColors(); paintPreview(); },
      }, color === choice ? icon("check") : "");
      colorHost.appendChild(btn);
    }
  }
  function paintIcons() {
    clear(iconHost);
    for (const choice of PRODUCT_ICON_NAMES) {
      const btn = h("button", {
        class: `thumb${chosenIcon === choice ? " is-active" : ""}`,
        type: "button",
        title: choice,
        onClick: () => { chosenIcon = choice; paintIcons(); paintPreview(); },
      }, productIcon(choice));
      iconHost.appendChild(btn);
    }
  }
  paintColors();
  paintIcons();
  paintPreview();

  const tileLabelText = h("div", { class: "strong small" }, name.value.trim() || "Category tile");
  const instance = modal({
    title: isEdit ? `Edit ${category.name}` : "New category",
    subtitle: "Products in this category inherit its icon and colour",
    size: "sm",
    body: h("div", { class: "col gap-3" }, errorHost,
      h("div", { class: "tile-preview" },
        preview,
        h("div", { class: "tile-preview__text" },
          tileLabelText,
          h("div", { class: "tiny dim" }, "Shown on every product tile in this category"))),
      formGrid([
        field({ label: "Name", control: name, required: true }),
        field({ label: "Department", control: department }),
      ]),
      field({ label: "Tile colour", control: colorHost }),
      field({ label: "Icon", control: iconHost }),
      active,
      isEdit ? h("div", { class: "tiny dim" }, `${category.product_count} product${category.product_count === 1 ? "" : "s"} in this category`) : null),
    footer: [button("Cancel", { onClick: () => instance.close() }),
      button(isEdit ? "Save" : "Create", { variant: "primary", icon: isEdit ? "check" : "plus", onClick: async (event) => {
        const trigger = event.currentTarget;
        if (!name.value.trim()) {
          errorHost.appendChild(alertBox("Give the category a name.", "danger"));
          name.focus();
          return;
        }
        clear(errorHost);
        trigger.setLoading(true);
        const payload = {
          name: name.value.trim(),
          color,
          icon: chosenIcon,
          department_id: department.value ? Number(department.value) : null,
          is_active: active.input.checked,
        };
        try {
          if (isEdit) await patch(`/categories/${category.id}`, payload);
          else await post("/categories", payload);
          toast("Category saved.", "success");
          instance.close();
          onSaved();
        } catch (error) {
          errorHost.appendChild(alertBox(error.message, "danger"));
          trigger.setLoading(false);
        }
      } })],
  });

  name.addEventListener("input", () => {
    tileLabelText.textContent = name.value.trim() || "Category tile";
  });
}

export function openCategoriesManager({ departments = [], onChanged = () => {} } = {}) {
  if (!requireBranchAction()) return;
  let categories = [];
  let loaded = false;
  const list = h("div", { class: "col gap-2" },
    h("div", { class: "loading-block" }, h("div", { class: "spinner" }), h("span", {}, "Loading categories")));
  const errorHost = h("div");

  async function refresh() {
    const data = await get("/categories");
    categories = data.items || [];
    loaded = true;
    render();
    onChanged();
  }

  function render() {
    if (!loaded) return;
    clear(list);
    for (const category of categories) {
      list.appendChild(h("div", { class: "cat-row" },
        h("span", { class: "cat-row__tile", style: { background: `${category.color}1f`, color: category.color } },
          productIcon(category.icon || "tag")),
        h("div", { class: "grow", style: { minWidth: 0 } },
          h("div", { class: "strong small truncate" }, category.name),
          h("div", { class: "tiny dim truncate" },
            `${category.department || "No department"} / ${category.product_count} product${category.product_count === 1 ? "" : "s"}`)),
        iconButton("edit", { size: "sm", variant: "ghost", title: "Edit category", onClick: () => {
          openCategoryEditor({ category, departments, onSaved: refresh });
        } }),
        iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete category", onClick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${category.name}?`,
            message: "Products in this category become uncategorised.",
            confirmLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
          await del(`/categories/${category.id}`);
          toast("Category deleted.", "success");
          await refresh();
        } })));
    }
    if (!categories.length) {
      list.appendChild(emptyState({ icon: "tag", title: "No categories yet",
        text: "Create one to give its products a matching icon and tile colour." }));
    }
  }

  const instance = modal({
    title: "Categories",
    subtitle: "Each category gives its products an icon and tile colour",
    body: h("div", { class: "col gap-3" },
      errorHost,
      list,
      button("New category", { variant: "primary", icon: "plus", block: true, onClick: () => {
        openCategoryEditor({ departments, onSaved: refresh });
      } })),
    footer: [button("Done", { variant: "primary", onClick: () => instance.close() })],
  });

  get("/categories").then((data) => {
    categories = data.items || [];
    loaded = true;
    render();
  }).catch((error) => {
    loaded = true;
    render();
    errorHost.appendChild(alertBox(error.message, "danger"));
  });
}
