/* Barcode studio: mint in-store EAN-13 codes and print label sheets. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { get, post } from "../core/http.js";
import { moduleConfig } from "../core/store.js";
import {
  pageHeader, sectionCard, button, badge, toast, alertBox, emptyState,
  field, textInput, segmented, switchRow,
} from "../core/ui.js";

export default async function barcodesView() {
  const el = h("div", { class: "bstudio" });
  const config = moduleConfig("barcode") || {};

  const state = {
    summary: null,
    products: [],
    selected: new Set(),
    search: "",
    copies: 1,
    width: Math.round(Number(config.label_width_mm) || 50),
    height: Math.round(Number(config.label_height_mm) || 25),
    showPrice: config.show_price_on_label !== false,
    layout: "sheet",
    busy: false,
    error: "",
  };

  const summaryHost = h("div", { class: "grid grid--kpi mb-4" });
  const productsHost = h("div");
  const setupBody = h("div", { class: "col gap-3" });
  const previewHost = h("div", { class: "bstudio__labels" });

  el.appendChild(pageHeader({
    title: "Barcode studio",
    subtitle: "Create in-store codes, print labels, stick them on the shelf",
    actions: [button("Print labels", { icon: "print", variant: "primary", onClick: () => printLabels() })],
  }));
  el.appendChild(h("div", { class: "bstudio__body" },
    h("div", { class: "bstudio__main" }, summaryHost, productsHost),
    h("div", { class: "bstudio__side" },
      sectionCard({ title: "Label setup", subtitle: "Mirrors the Barcode module settings", body: setupBody }),
      sectionCard({ title: "Preview", subtitle: "What comes out of the label printer", body: previewHost }))));

  const search = textInput({ placeholder: "Search name, SKU or barcode…", className: "input--sm" });
  search.addEventListener("input", debounce(() => {
    state.search = search.value.trim();
    loadProducts().catch((error) => toast(error.message, "error"));
  }, 250));

  const selectedIds = () => [...state.selected];

  function printLabels() {
    const ids = selectedIds();
    if (!ids.length) {
      toast("Pick at least one product to print.", "warning");
      return;
    }
    const params = new URLSearchParams({
      ids: ids.join(","),
      copies: String(state.copies),
      width_mm: String(state.width),
      height_mm: String(state.height),
      show_price: state.showPrice ? "1" : "0",
      layout: state.layout,
    });
    const win = window.open(`/api/barcodes/labels?${params.toString()}`, "_blank", "width=780,height=900");
    if (!win) toast("Allow pop-ups to print labels.", "warning");
  }

  function renderSummary() {
    clear(summaryHost);
    const counts = state.summary?.counts || {};
    const tiles = [
      { label: "Products", value: counts.products ?? "—", icon: "box" },
      { label: "Ready to scan", value: counts.ready ?? "—", icon: "barcode", tone: "success" },
      { label: "Missing a code", value: counts.missing ?? "—", icon: "warn", tone: counts.missing ? "warning" : "" },
      { label: "Label size", value: `${state.width}×${state.height} mm`, icon: "tag" },
    ];
    for (const tile of tiles) {
      summaryHost.appendChild(h("div", { class: `kpi${tile.tone ? ` kpi--${tile.tone}` : ""}` },
        h("div", { class: "kpi__icon" }, icon(tile.icon)),
        h("div", { class: "kpi__label" }, tile.label),
        h("div", { class: "kpi__value" }, String(tile.value))));
    }
  }

  function selectOnly(id) {
    state.selected = new Set([id]);
    renderProducts();
    renderPreview();
  }

  function toggle(id, on) {
    if (on) state.selected.add(id);
    else state.selected.delete(id);
    renderProducts();
    renderPreview();
  }

  function renderProducts() {
    clear(productsHost);
    const term = state.search.toLowerCase();
    const rows = state.products.filter((row) => !term
      || `${row.name} ${row.sku || ""} ${row.barcode || ""}`.toLowerCase().includes(term));
    const missing = rows.filter((row) => !(row.barcode || "").trim());

    const rowEl = (row) => {
      const code = (row.barcode || "").trim();
      const checked = state.selected.has(row.id);
      return h("div", { class: `pick-row${checked ? " is-checked" : ""}` },
        h("label", { class: "pick-row__check" },
          h("input", { type: "checkbox", checked, onChange: (event) => toggle(row.id, event.target.checked) })),
        h("div", { class: "pick-row__text" },
          h("div", { class: "pick-row__name" }, row.name),
          h("div", { class: "pick-row__meta" },
            row.sku ? h("span", {}, row.sku) : null,
            code ? h("span", { class: "mono" }, code) : h("span", { class: "pick-row__missing" }, "No barcode"))),
        code ? null : badge("Missing", "warning"),
        button(code ? "Reprint" : "Make code", {
          size: "sm",
          variant: "ghost",
          icon: "barcode",
          onClick: () => (code ? selectOnly(row.id) : generate([row.id])),
        }));
    };

    const list = rows.length
      ? h("div", { class: "pick-list" }, rows.map(rowEl))
      : emptyState({
        icon: "box",
        title: state.search ? "Nothing matched" : "No products yet",
        text: state.search ? "Try another name, SKU or barcode." : "Add a product first, then mint its barcode here.",
      });

    productsHost.appendChild(sectionCard({
      title: "Pick products",
      subtitle: `${rows.length} shown · ${state.selected.size} selected`,
      actions: h("div", { class: "flex gap-2" },
        button("Select missing", {
          size: "sm", variant: "ghost", disabled: !missing.length,
          onClick: () => {
            state.selected = new Set(missing.map((row) => row.id));
            renderProducts();
            renderPreview();
          },
        }),
        button("Clear", {
          size: "sm", variant: "ghost", disabled: !state.selected.size,
          onClick: () => {
            state.selected.clear();
            renderProducts();
            renderPreview();
          },
        })),
      body: h("div", { class: "bstudio__pick" },
        h("div", { class: "bstudio__search" }, icon("search"), search),
        list),
    }));
  }

  async function generate(ids) {
    state.busy = true;
    renderSetup();
    try {
      const result = await post("/barcodes/generate", ids?.length ? { product_ids: ids } : {});
      const made = result.generated || 0;
      if (made) {
        state.selected = new Set([...state.selected, ...(result.items || []).map((item) => item.id)]);
        toast(`${made} barcode${made === 1 ? "" : "s"} created.`, "success");
      } else {
        toast("Every product already has a code.", "info");
      }
      await Promise.all([loadSummary(), loadProducts()]);
      renderPreview();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.busy = false;
      renderSetup();
    }
  }

  function numberField(value, onChange, { min = 1, max = 400 } = {}) {
    const input = textInput({ type: "number", value: String(value), className: "input--sm" });
    input.addEventListener("change", () => {
      const next = Math.min(max, Math.max(min, Math.round(Number(input.value) || min)));
      input.value = String(next);
      onChange(next);
    });
    return input;
  }

  function renderSetup() {
    clear(setupBody);
    const missing = state.summary?.counts?.missing || 0;
    setupBody.appendChild(alertBox(
      "Each product gets its own EAN-13 code in the GS1 in-store range, so any retail scanner reads it.",
      "info"));
    setupBody.appendChild(h("div", { class: "grid grid--2 gap-3" },
      field({ label: "Width (mm)", control: numberField(state.width, (value) => { state.width = value; renderSummary(); }) }),
      field({ label: "Height (mm)", control: numberField(state.height, (value) => { state.height = value; renderSummary(); }) })));
    setupBody.appendChild(field({ label: "Copies per product", control: numberField(state.copies, (value) => { state.copies = value; }) }));
    setupBody.appendChild(h("div", { class: "col gap-2" },
      h("div", { class: "field__label" }, "Printer"),
      segmented([{ value: "sheet", label: "A4 sheet" }, { value: "roll", label: "Label roll" }], {
        value: state.layout,
        onChange: (value) => { state.layout = value; renderSetup(); },
      }),
      h("div", { class: "field__hint" }, state.layout === "roll"
        ? "One label per page — set the printer's paper to the label size."
        : "Labels laid out on A4 with cut guides.")));
    setupBody.appendChild(switchRow({
      title: "Print the price",
      hint: "Hide it for wholesale or bin labels.",
      checked: state.showPrice,
      onChange: (value) => { state.showPrice = value; renderPreview(); },
    }));
    setupBody.appendChild(h("div", { class: "flex gap-2" },
      button("Generate missing", {
        icon: "barcode",
        loading: state.busy,
        disabled: state.busy || !missing,
        onClick: () => generate(null),
      }),
      button("Print", { icon: "print", variant: "primary", onClick: () => printLabels() })));
    if (state.summary) {
      setupBody.appendChild(h("div", { class: "field__hint" },
        `${state.summary.counts.ready} of ${state.summary.counts.products} products already carry a scannable code.`));
    }
  }

  async function renderPreview() {
    const ids = selectedIds().length
      ? selectedIds()
      : state.products.filter((row) => (row.barcode || "").trim()).slice(0, 4).map((row) => row.id);
    clear(previewHost);
    if (!ids.length) {
      previewHost.appendChild(emptyState({
        icon: "barcode",
        title: "Nothing to preview yet",
        text: "Pick a product and its label shows up here.",
      }));
      return;
    }
    try {
      const result = await post("/barcodes/preview", { product_ids: ids.slice(0, 12), show_price: state.showPrice });
      clear(previewHost);
      for (const item of result.items || []) {
        const svgBox = h("div", { class: "label-preview__svg" });
        svgBox.innerHTML = item.svg || "";
        previewHost.appendChild(h("div", { class: "label-preview" },
          h("div", { class: "label-preview__name" }, item.name),
          svgBox,
          h("div", { class: "label-preview__foot" },
            h("span", { class: "mono" }, item.code),
            item.price ? h("strong", {}, item.price) : null)));
      }
      state.error = "";
    } catch (error) {
      state.error = error.message;
      previewHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  async function loadSummary() {
    state.summary = await get("/barcodes/summary");
    renderSummary();
  }

  async function loadProducts() {
    const data = await get("/products", { per_page: 200, q: state.search });
    state.products = data.items || [];
    for (const id of [...state.selected]) {
      if (!state.products.some((row) => row.id === id)) state.selected.delete(id);
    }
    renderProducts();
  }

  try {
    await Promise.all([loadSummary(), loadProducts()]);
  } catch (error) {
    el.appendChild(alertBox(error.message, "danger"));
    return { el };
  }

  if (state.summary?.enabled === false) {
    el.appendChild(alertBox(
      "Turn on the Barcode module in Settings → Modules to mint codes and print labels.", "warning"));
  }

  renderSetup();
  renderPreview();
  return { el };
}
