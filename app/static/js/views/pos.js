/* Point of sale: catalog browser, cart, payments, holds and drawer. */

import { h, clear, debounce } from "../core/dom.js";
import { icon, productIcon } from "../core/icons.js";
import { money, number, qty as fmtQty, date, isoDay, addDays } from "../core/fmt.js";
import { get, post, del } from "../core/http.js";
import {
  store, hasPerm, moduleOn, moduleConfig, settings, currentUser, currency, currentCompany,
} from "../core/store.js";
import { posPreference } from "../core/prefs.js";
import { branchScope, setBranchScope } from "../core/branch.js";
import {
  button, iconButton, modal, drawer, field, textInput, textarea, select, switchControl,
  toast, badge, statusBadge, emptyState, alertBox, confirmDialog, tagInput, menu, moneyInput, searchLoader,
} from "../core/ui.js";
import { printReceipt } from "./saleDetail.js";
import { offerOfflineSave } from "../core/offlineUi.js";

const SOUND_ON = () => posPreference("sound_enabled", moduleConfig("pos").sound_enabled !== false);
const AUTO_PRINT = () => posPreference("auto_print", Boolean(moduleConfig("pos").auto_print));

export default async function posView(ctx) {
  const el = h("div", { class: "pos is-loading" });
  const skeletonTile = () => h("div", { class: "pos-skeleton__tile" },
    h("div", { class: "skeleton", style: { width: "38px", height: "38px", "border-radius": "10px" } }),
    h("div", { class: "skeleton", style: { width: "72%", height: "10px", "margin-top": "auto" } }),
    h("div", { class: "skeleton", style: { width: "46%", height: "14px" } }));
  const loadingSkeleton = h("div", { class: "pos-skeleton", attrs: { role: "status", "aria-live": "polite" } },
    h("span", { class: "sr-only" }, "Opening the till"),
    h("div", { class: "pos-skeleton__toolbar", attrs: { "aria-hidden": "true" } },
      h("div", { class: "skeleton", style: { flex: "1", height: "42px", "border-radius": "10px" } }),
      h("div", { class: "skeleton", style: { width: "112px", height: "34px", "border-radius": "9px" } }),
      h("div", { class: "skeleton", style: { width: "34px", height: "34px", "border-radius": "9px" } })),
    h("div", { class: "pos-skeleton__filters", attrs: { "aria-hidden": "true" } },
      h("div", { class: "skeleton", style: { width: "210px", height: "33px", "border-radius": "8px" } }),
      h("div", { class: "skeleton", style: { width: "180px", height: "33px", "border-radius": "8px" } })),
    h("div", { class: "pos-skeleton__grid", attrs: { "aria-hidden": "true" } },
      Array.from({ length: 16 }, skeletonTile)));
  el.appendChild(loadingSkeleton);

  const state = {
    products: [],
    categories: [],
    departments: [],
    methods: [],
    staff: [],
    config: {},
    modules: {},
    settings: {},
    cart: [],
    customer: null,
    discount: null,
    note: "",
    tip: 0,
    redeem: 0,
    search: "",
    categoryId: null,
    departmentId: null,
    shift: null,
    holds: [],
    locations: [],
    registers: [],
    locationId: null,
    lastSale: null,
    taxRates: [],
  };

  const left = h("div", { class: "pos__left" });
  const right = h("div", { class: "pos__right" });
  el.appendChild(left);
  el.appendChild(right);

  /* --------------------------------------------------------------------- */
  /* Data                                                                   */
  /* --------------------------------------------------------------------- */
  async function load() {
    const scope = branchScope();
    if (scope.all) {
      state.allBranches = true;
      state.locations = branchLocations();
      loadingSkeleton.remove();
      el.classList.remove("is-loading");
      renderAllBranchesNotice();
      return;
    }
    const data = await get("/pos/bootstrap");
    const allowCredit = (data.config.customers || {}).allow_credit !== false;
    Object.assign(state, {
      products: data.products,
      categories: data.categories,
      departments: data.departments || [],
      methods: (data.payment_methods || []).filter((method) => allowCredit || method.type !== "credit"),
      staff: data.staff,
      config: data.config,
      modules: data.modules,
      settings: data.settings,
      shift: data.shift,
      holds: data.held_carts,
      locations: (data.locations || []).filter((row) => row.is_active),
      registers: data.registers || [],
      taxRates: data.taxes,
    });
    const savedBranch = Number(localStorage.getItem(`pos-branch:${currentCompany()?.slug || "default"}`)) || null;
    state.allBranches = false;
    state.locationId = scope.locationId
      || (state.locations.some((row) => row.id === savedBranch)
        ? savedBranch
        : (state.locations.find((row) => row.is_default)?.id || state.locations[0]?.id || null));
    loadingSkeleton.remove();
    el.classList.remove("is-loading");
    renderAll();
    window.dispatchEvent(new CustomEvent("pos:ready"));
    const search = el.querySelector("[data-pos-search]");
    if (search) search.focus();
  }

  function renderAllBranchesNotice() {
    clear(el);
    const branches = state.locations;
    el.appendChild(h("div", { class: "pos-readonly" },
      h("div", { class: "pos-readonly__card" },
        h("div", { class: "module-card__icon" }, icon("layers")),
        h("h2", { class: "pos-readonly__title" }, "All branches is a reporting view"),
        h("p", { class: "pos-readonly__text" },
          "Sales, stock and reports are combined across every shop, but a sale must belong to one branch. Choose a branch to open the till."),
        h("div", { class: "pos-readonly__branches" },
          branches.map((branch) => h("button", {
            class: "pos-readonly__branch",
            type: "button",
            onClick: () => {
              setBranchScope(branch.id);
              window.location.reload();
            },
          }, icon("map"),
          h("span", { class: "grow" },
            h("span", { class: "strong" }, branch.name),
            h("span", { class: "tiny dim" }, branch.code || branch.address || "Shop branch")),
          icon("chevronRight")))),
        h("div", { class: "flex justify-end mt-2" },
          button("Open reports", { icon: "chart", onClick: () => { window.location.hash = "#/reports"; } })))));
  }

  /* --------------------------------------------------------------------- */
  /* Pricing (mirrors the server engine so the cart never surprises anyone) */
  /* --------------------------------------------------------------------- */
  function computeTotals() {
    const taxCfg = state.config.tax_engine || {};
    const taxEnabled = Boolean(state.modules.tax_engine);
    const includeTax = Boolean(taxCfg.prices_include_tax);
    const lines = state.cart.map((line) => {
      const product = line.product;
      const gross = Math.round(line.unitPrice * line.qty);
      const lineDiscount = Math.min(gross, Math.max(0, Math.round(line.discount || 0)));
      const rate = taxEnabled && product.tax_rate ? Number(product.tax_rate.rate) || 0 : 0;
      const inclusive = product.tax_rate ? Boolean(product.tax_rate.is_inclusive) : includeTax;
      return { line, product, gross, lineDiscount, base: gross - lineDiscount, rate, inclusive, allocated: 0, tax: 0 };
    });

    const grossSubtotal = lines.reduce((sum, row) => sum + row.gross, 0);
    const lineDiscounts = lines.reduce((sum, row) => sum + row.lineDiscount, 0);
    const netBeforeCart = grossSubtotal - lineDiscounts;

    let cartDiscount = 0;
    if (state.discount && netBeforeCart > 0) {
      if (state.discount.type === "percent") {
        cartDiscount = Math.round((netBeforeCart * Number(state.discount.value)) / 100);
      } else {
        cartDiscount = Math.round(Number(state.discount.value) || 0);
      }
      cartDiscount = Math.max(0, Math.min(cartDiscount, netBeforeCart));
    }

    let remaining = cartDiscount;
    lines.forEach((row, index) => {
      if (!cartDiscount || netBeforeCart <= 0) return;
      const share = index === lines.length - 1
        ? remaining
        : Math.min(remaining, Math.round((cartDiscount * row.base) / netBeforeCart));
      row.allocated = share;
      remaining -= share;
    });

    let tax = 0;
    const breakdown = {};
    for (const row of lines) {
      const base = row.base - row.allocated;
      const rate = row.rate / 100;
      const value = row.inclusive
        ? Math.round(base - base / (1 + rate))
        : Math.round(base * rate);
      row.tax = value;
      tax += value;
      const key = String(row.rate);
      breakdown[key] = (breakdown[key] || 0) + value;
    }

    const net = lines.reduce((sum, row) => sum + (row.base - row.allocated), 0);
    const serviceCfg = state.config.service_charge || {};
    const service = state.modules.service_charge
      ? Math.round((net * Number(serviceCfg.percent || 0)) / 100)
      : 0;

    const tip = Math.max(0, Math.round(state.tip || 0));

    let redeemCents = 0;
    let pointsRedeemed = 0;
    const loyaltyCfg = state.config.loyalty || {};
    if (state.modules.loyalty && state.customer && state.redeem) {
      const unit = Number(loyaltyCfg.redeem_value || 0);
      const minimum = Math.max(0, Number(loyaltyCfg.minimum_redeem || 0));
      const available = Math.min(state.redeem, state.customer.loyalty_points || 0);
      redeemCents = available >= minimum ? Math.round(available * unit) : 0;
      pointsRedeemed = available >= minimum ? available : 0;
      const cap = net + tax + service + tip;
      if (redeemCents > cap) {
        redeemCents = cap;
        pointsRedeemed = unit ? Math.floor(cap / unit) : available;
      }
    }

    let beforeRounding = net + tax + service + tip - redeemCents;
    let rounding = 0;
    if (state.modules.rounding && beforeRounding > 0) {
      const cfg = state.config.rounding || {};
      const increment = Math.max(1, Number(cfg.increment || 1));
      const quotient = Math.floor(beforeRounding / increment);
      const remainder = beforeRounding % increment;
      let target = beforeRounding;
      if (remainder !== 0) {
        if (cfg.mode === "up") target = (quotient + 1) * increment;
        else if (cfg.mode === "down") target = quotient * increment;
        else target = remainder * 2 >= increment ? (quotient + 1) * increment : quotient * increment;
      }
      rounding = target - beforeRounding;
    }

    return {
      lines,
      grossSubtotal,
      lineDiscounts,
      cartDiscount,
      discount: lineDiscounts + cartDiscount,
      net,
      tax,
      breakdown,
      service,
      tip,
      redeemCents,
      pointsRedeemed,
      rounding,
      total: beforeRounding + rounding,
      itemCount: state.cart.reduce((sum, line) => sum + line.qty, 0),
    };
  }

  /* --------------------------------------------------------------------- */
  /* Cart mutations                                                         */
  /* --------------------------------------------------------------------- */
  function addProduct(product) {
    if (product.track_stock && product.stock_qty <= 0 && !((state.config.inventory || {}).allow_negative)) {
      toast(`${product.name} is out of stock.`, "warning");
      return;
    }
    const existing = state.cart.find((line) => line.product.id === product.id && !line.note && line.unitPrice === product.price_cents);
    if (existing) {
      existing.qty += 1;
    } else {
      state.cart.push({
        product,
        qty: 1,
        unitPrice: product.price_cents,
        discount: 0,
        note: "",
      });
    }
    beep();
    renderCart();
    renderGrid();
  }

  /* A barcode scanner types the code and presses Enter, often while focus sits
     somewhere else entirely. Look the code up (falling back to the server when
     the product arrived after the till was opened) and drop it in the cart. */
  async function scanCode(raw) {
    const code = String(raw || "").trim();
    if (!code) return false;
    const lower = code.toLowerCase();
    let match = state.products.find(
      (product) => (product.barcode || "").toLowerCase() === lower
        || (product.sku || "").toLowerCase() === lower,
    );
    if (!match) {
      try {
        const data = await get("/products/lookup", { code });
        match = data.item;
        if (match && !state.products.some((row) => row.id === match.id)) state.products.push(match);
      } catch {
        match = null;
      }
    }
    if (!match) {
      toast(`No product matches “${code}”.`, "warning", "Code not found");
      return false;
    }
    addProduct(match);
    flashCart();
    return true;
  }

  function flashCart() {
    right.classList.remove("is-scanned");
    void right.offsetWidth;
    right.classList.add("is-scanned");
    setTimeout(() => right.classList.remove("is-scanned"), 620);
  }

  let scanBuffer = "";
  let scanAt = 0;
  function onScanKey(event) {
    if (!el.isConnected || el.offsetParent === null) return;
    if (!moduleOn("barcode") || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector(".modal, dialog[open]")) return;
    const target = event.target;
    const tag = target?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
    if (typing && target?.dataset?.posSearch !== "1") return;
    if (event.key === "Enter") {
      const code = scanBuffer.trim();
      scanBuffer = "";
      if (code.length >= 4) {
        event.preventDefault();
        scanCode(code);
      }
      return;
    }
    if (event.key.length !== 1) {
      scanBuffer = "";
      return;
    }
    const now = performance.now();
    if (now - scanAt > 120) scanBuffer = "";
    scanAt = now;
    scanBuffer = (scanBuffer + event.key).slice(-64);
  }
  document.addEventListener("keydown", onScanKey);

  function changeQty(line, delta) {
    const next = Math.round((line.qty + delta) * 1000) / 1000;
    if (next <= 0) {
      removeLine(line);
      return;
    }
    const product = line.product;
    const allowNegative = Boolean((state.config.inventory || {}).allow_negative);
    if (product.track_stock && !allowNegative && next > product.stock_qty) {
      toast(`Only ${fmtQty(product.stock_qty)} of ${product.name} left.`, "warning");
      return;
    }
    line.qty = next;
    renderCart();
  }

  function removeLine(line) {
    state.cart = state.cart.filter((entry) => entry !== line);
    renderCart();
  }

  function clearCart() {
    state.cart = [];
    state.customer = null;
    state.discount = null;
    state.note = "";
    state.tip = 0;
    state.redeem = 0;
    renderCart();
    renderGrid();
  }

  function beep() {
    if (!SOUND_ON()) return;
    try {
      const audio = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.03;
      osc.start();
      osc.stop(audio.currentTime + 0.05);
    } catch { /* silent */ }
  }

  /* --------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* --------------------------------------------------------------------- */
  function renderAll() {
    renderLeft();
    renderCart();
  }

  function renderLeft() {
    clear(left);
    const cfg = state.config.pos || {};
    const showBranches = moduleOn("multi_location") && state.locations.length > 1;
    const branchLabel = showBranches
      ? (state.locations.find((row) => row.id === state.locationId)?.name || "Branch")
      : (state.locations[0]?.name || "");
    const heldOrders = Boolean(state.modules.holders);
    const searchInput = searchLoader(h("input", {
      class: "input",
      placeholder: "Search products or scan a barcode…",
      value: state.search,
      dataset: { posSearch: "1" },
      onInput: debounce((e) => {
        state.search = e.target.value;
        renderGrid();
      }, 120),
      onKeyDown: async (e) => {
        if (e.key !== "Enter") return;
        const term = e.target.value.trim();
        if (!term) return;
        // Enter means "this is a complete code" — scan it instead of filtering.
        if (await scanCode(term)) {
          e.target.value = "";
          state.search = "";
          renderGrid();
        }
      },
    }));

    left.appendChild(h("div", { class: "pos__toolbar" },
      h("div", { class: "pos__search" }, icon("search"), searchInput),
      showBranches ? h("button", {
        class: "btn btn--sm",
        type: "button",
        title: "Switch branch",
        onClick: (e) => openBranchMenu(e.currentTarget),
      }, icon("map"), h("span", {}, branchLabel)) : null,
      h("div", { class: "flex gap-2" },
        heldOrders
          ? button(state.holds.length ? `Held (${state.holds.length})` : "Held orders", {
            size: "sm",
            icon: "pause",
            variant: state.holds.length ? "" : "ghost",
            title: "Parked carts you can finish later",
            onClick: openHolds,
          })
          : null,
        state.modules.shifts
          ? h("button", {
            class: `btn btn--sm ${state.shift ? "" : "btn--soft"}`,
            type: "button",
            onClick: () => (state.shift ? openCloseShift() : openShiftModal()),
            title: state.shift ? "Close the drawer" : "Open the drawer",
          }, icon("clock"), h("span", {}, state.shift ? "Drawer open" : "Open drawer"))
          : null,
        hasPerm("users.manage") && state.staff.length > 1
          ? iconButton("user", { title: "Switch cashier", onClick: (e) => openStaffMenu(e.currentTarget) })
          : null)));

    const visibleCategories = state.departmentId
      ? state.categories.filter((category) => category.department_id === state.departmentId)
      : state.categories;

    if (state.departments.length || visibleCategories.length) {
      const filters = h("div", { class: "pos__filters" });
      if (state.departments.length) {
        filters.appendChild(h("label", { class: "pos__filter" },
          icon("layers"),
          select({
            value: state.departmentId ?? "",
            options: [
              { value: "", label: "All departments" },
              ...state.departments.map((department) => ({ value: department.id, label: department.name })),
            ],
            onChange: (event) => {
              state.departmentId = event.target.value ? Number(event.target.value) : null;
              state.categoryId = null;
              renderGrid();
              renderLeft();
            },
          })));
      }
      if (visibleCategories.length) {
        filters.appendChild(h("label", { class: "pos__filter" },
          icon("tag"),
          select({
            value: state.categoryId ?? "",
            options: [
              { value: "", label: "All items" },
              ...visibleCategories.map((category) => ({ value: category.id, label: category.name })),
            ],
            onChange: (event) => {
              state.categoryId = event.target.value ? Number(event.target.value) : null;
              renderGrid();
              renderLeft();
            },
          })));
      }
      left.appendChild(filters);
    }

    const gridWrap = h("div", { class: "pos__grid-wrap" });
    gridWrap.appendChild(h("div", {
      class: "pos-grid",
      dataset: { grid: "1" },
      style: { gridTemplateColumns: `repeat(${Number(cfg.grid_columns) || 4}, minmax(0, 1fr))` },
    }));
    left.appendChild(gridWrap);

    if (state.modules.shifts && !state.shift && (state.config.shifts || {}).require_open_shift) {
      left.insertBefore(alertBox("Open a cash drawer session before taking payments.", "warning"), gridWrap);
    }
    renderGrid();
  }

  function filteredProducts() {
    const term = state.search.trim().toLowerCase();
    return state.products.filter((product) => {
      if (state.departmentId && product.department_id !== state.departmentId) return false;
      if (state.categoryId && product.category_id !== state.categoryId) return false;
      if (!term) return true;
      return `${product.name} ${product.sku} ${product.barcode} ${product.category || ""}`.toLowerCase().includes(term);
    });
  }

  function renderGrid() {
    const grid = left.querySelector("[data-grid]") || left.querySelector(".pos-grid");
    if (!grid) return;
    const cfg = state.config.pos || {};
    const cols = Number(cfg.grid_columns) || 4;
    const available = (grid.parentElement?.clientWidth || 0) - 32;
    const base = cols >= 6 ? 156 : cols === 5 ? 172 : cols === 4 ? 188 : 208;
    // Never stretch a handful of tiles across the whole pane on narrow screens.
    const minWidth = available && available < 700 ? Math.min(base, 168) : base;
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minWidth}px, 1fr))`;
    clear(grid);
    const items = filteredProducts();
    if (!items.length) {
      grid.appendChild(h("div", { style: { gridColumn: "1 / -1" } },
        emptyState({ icon: "search", title: "Nothing matched", text: "Try a different search or category." })));
      return;
    }
    for (const product of items) {
      const allowNegative = Boolean((state.config.inventory || {}).allow_negative);
      const tracked = Boolean(product.track_stock);
      const out = tracked && product.stock_qty <= 0 && !allowNegative;
      const low = tracked && !out && product.stock_qty <= (product.low_stock_threshold ?? 0);
      const stockState = out ? "is-out" : low ? "is-low" : tracked ? "is-in" : "";
      const tile = h("button", {
        class: `pos-tile${stockState ? ` ${stockState}` : ""}`,
        type: "button",
        title: `${product.name} · ${money(product.price_cents)}${tracked ? ` · ${fmtQty(product.stock_qty)} in stock` : ""}`,
        style: { "--tile-color": product.category_color || product.color || "var(--primary)" },
        onClick: () => addProduct(product),
      });
      if (cfg.show_images !== false) {
        tile.appendChild(h("span", { class: "pos-tile__icon" }, productIcon(product.icon || "box")));
      }
      const name = h("span", { class: "pos-tile__name" }, product.name);
      if (product.is_featured) {
        name.appendChild(h("span", { class: "pos-tile__badge", title: "Featured" }, icon("star")));
      }
      const stock = cfg.show_stock !== false && tracked
        ? h("span", {
          class: "pos-tile__stock",
          title: out ? "Out of stock" : low ? `Low stock · ${fmtQty(product.low_stock_threshold)} is the reorder point` : `${fmtQty(product.stock_qty)} in stock`,
        }, out ? "Out of stock" : low ? `${fmtQty(product.stock_qty)} left · low` : `${fmtQty(product.stock_qty)} left`)
        : null;
      tile.appendChild(name);
      tile.appendChild(h("span", { class: "pos-tile__meta" },
        h("span", { class: "pos-tile__price" }, money(product.price_cents)),
        stock));
      grid.appendChild(tile);
    }
  }

  function renderCart() {
    clear(right);
    const totals = computeTotals();
    const cfg = state.config.pos || {};

    /* header */
    const head = h("div", { class: "cart__head" },
      h("div", { class: "grow" },
        h("div", { class: "strong" }, "Current sale"),
        h("div", { class: "tiny dim" }, `${number(totals.itemCount, 0)} item${totals.itemCount === 1 ? "" : "s"} · ${currentUser().full_name}`)),
      state.holds.length ? iconButton("pause", { title: `Held orders (${state.holds.length})`, onClick: openHolds }) : null,
      iconButton("trash", { title: "Clear cart", onClick: async () => {
        if (!state.cart.length) return;
        if (await confirmDialog({ title: "Clear this sale?", message: "All items will be removed from the cart.", confirmLabel: "Clear", danger: true })) clearCart();
      } }));
    right.appendChild(head);

    /* customer strip */
    const customerStrip = h("button", {
      class: "btn btn--ghost",
      type: "button",
      style: { borderRadius: "0", borderBottom: "1px solid var(--border)", height: "40px", justifyContent: "flex-start", gap: "8px", padding: "0 15px" },
      onClick: openCustomerPicker,
    }, icon("user"));
    customerStrip.appendChild(h("span", { class: "grow", style: { textAlign: "left" } },
      state.customer ? state.customer.name : "Walk-in customer"));
    if (state.customer) {
      customerStrip.appendChild(badge(`${state.customer.loyalty_points} pts`, "primary"));
      customerStrip.appendChild(iconButton("x", { size: "sm", variant: "ghost", title: "Remove customer", onClick: (e) => {
        e.stopPropagation();
        state.customer = null;
        state.redeem = 0;
        renderCart();
      } }));
    } else {
      customerStrip.appendChild(h("span", { class: "tiny dim" }, "Add"));
    }
    right.appendChild(customerStrip);

    /* items */
    const items = h("div", { class: "cart__items" });
    if (!state.cart.length) {
      items.appendChild(h("div", { class: "cart__empty" },
        icon("cart"),
        h("div", { class: "strong" }, "Cart is empty"),
        h("div", { class: "small" }, "Tap a product or scan a barcode to begin."),
        state.modules.holders
          ? h("button", {
            class: "btn btn--sm btn--ghost mt-2",
            type: "button",
            onClick: openHolds,
          }, icon("pause"),
          h("span", {}, state.holds.length
            ? `Finish a parked order (${state.holds.length})`
            : "Held orders live here"))
          : null));
    } else {
      state.cart.forEach((line) => {
        const lineTotal = Math.round(line.unitPrice * line.qty) - (line.discount || 0);
        const row = h("div", { class: "cart-line" },
          h("div", { class: "cart-line__name" }, line.product.name),
          h("div", { class: "cart-line__amount" }, money(lineTotal)),
          h("div", { class: "cart-line__meta" },
            h("span", {}, money(line.unitPrice)),
            line.product.tax_rate ? h("span", { class: "dim" }, `· ${number(line.product.tax_rate.rate, 0)}% tax`) : null,
            line.discount ? h("span", { style: { color: "var(--success)" } }, `· -${money(line.discount)}`) : null),
          line.note ? h("div", { class: "cart-line__note" }, line.note) : null,
          h("div", { class: "cart-line__controls" },
            h("div", { class: "stepper" },
              h("button", { type: "button", title: "Less", onClick: () => changeQty(line, -1) }, icon("minus")),
              h("input", {
                type: "number", value: line.qty, min: "0", step: "1",
                onChange: (e) => {
                  const value = Number(e.target.value) || 0;
                  if (value <= 0) { removeLine(line); return; }
                  line.qty = value;
                  renderCart();
                },
              }),
              h("button", { type: "button", title: "More", onClick: () => changeQty(line, 1) }, icon("plus"))),
            h("div", { class: "grow" }),
            state.modules.price_overrides && (hasPerm("pos.override") || (state.config.price_overrides || {}).require_pin !== false)
              ? iconButton("edit", { size: "sm", variant: "ghost", title: "Change the price", onClick: () => openPriceOverride(line) })
              : null,
            state.modules.order_notes
              ? iconButton("note", { size: "sm", variant: "ghost", title: "Item note", onClick: () => openLineNote(line) })
              : null,
            iconButton("x", { size: "sm", variant: "ghost", danger: true, title: "Remove", onClick: () => removeLine(line) })));
        items.appendChild(row);
      });
    }
    right.appendChild(items);

    /* footer */
    const foot = h("div", { class: "cart__foot" });
    const totalsList = h("div", { class: "cart__totals" });
    totalsList.appendChild(rowLine("Subtotal", money(totals.grossSubtotal - totals.lineDiscounts)));
    if (totals.discount) totalsList.appendChild(rowLine(
      state.discount?.label || "Discount", `-${money(totals.discount)}`, "cart__row--save",
      state.discount ? iconButton("x", { size: "sm", variant: "ghost", title: "Remove discount", onClick: () => { state.discount = null; renderCart(); } }) : null));
    if (totals.tax) totalsList.appendChild(rowLine("Tax", money(totals.tax)));
    if (totals.service) totalsList.appendChild(rowLine("Service charge", money(totals.service)));
    if (totals.tip) totalsList.appendChild(rowLine("Tip", money(totals.tip)));
    if (totals.redeemCents) totalsList.appendChild(rowLine(`Loyalty (${totals.pointsRedeemed} pts)`, `-${money(totals.redeemCents)}`, "cart__row--save"));
    if (totals.rounding) totalsList.appendChild(rowLine("Rounding", money(totals.rounding)));
    totalsList.appendChild(h("div", { class: "cart__row cart__row--total" },
      h("span", {}, "Total"), h("span", { class: "num" }, money(totals.total))));
    foot.appendChild(totalsList);

    const actions = h("div", { class: "flex gap-2" });
    if (state.modules.discounts && hasPerm("discounts.manage")) {
      actions.appendChild(button("Discount", { size: "sm", icon: "percent", variant: state.discount ? "soft" : "", onClick: openDiscountModal }));
    }
    if (state.modules.tips) actions.appendChild(button("Tip", { size: "sm", icon: "heart", variant: state.tip ? "soft" : "", onClick: openTipModal }));
    if (state.modules.loyalty && state.customer) {
      actions.appendChild(button("Points", { size: "sm", icon: "star", variant: state.redeem ? "soft" : "", onClick: openRedeemModal }));
    }
    if (state.modules.layby && state.cart.length) {
      actions.appendChild(button("Lay-by", { size: "sm", icon: "wallet", onClick: openLaybyModal }));
    }
    foot.appendChild(actions);

    const payRow = h("div", { class: "flex gap-2 mt-3" });
    if (moduleOn("holders")) {
      payRow.appendChild(button("Hold", {
        size: "lg",
        icon: "pause",
        disabled: !state.cart.length,
        onClick: saveHold,
      }));
    }
    payRow.appendChild(button(`Charge ${money(totals.total)}`, {
      variant: "primary",
      size: "lg",
      icon: "card",
      block: true,
      disabled: !state.cart.length,
      onClick: openPayment,
    }));
    foot.appendChild(payRow);
    right.appendChild(foot);
  }

  function rowLine(label, value, extraClass = "", extra = null) {
    return h("div", { class: `cart__row ${extraClass}` },
      h("span", { class: "flex items-center gap-1" }, label, extra || null),
      h("span", { class: "num" }, value));
  }

  /* --------------------------------------------------------------------- */
  /* Customer                                                               */
  /* --------------------------------------------------------------------- */
  function openCustomerPicker() {
    const results = h("div", { class: "col gap-1" });
    const input = searchLoader(textInput({ placeholder: "Search by name, phone or email…", autofocus: true }));
    const body = h("div", { class: "col gap-3" }, input, results);
    const errorHost = h("div");

    const search = debounce(async () => {
      const term = input.value.trim();
      clear(results);
      if (!term) {
        results.appendChild(h("div", { class: "dim small center", style: { padding: "16px" } }, "Start typing to search customers"));
        return;
      }
      try {
        const { items } = await get("/customers/lookup", { q: term });
        if (!items.length) {
          results.appendChild(h("div", { class: "col gap-2 items-start", style: { padding: "8px 0" } },
            h("div", { class: "dim small" }, "No customers found."),
            button("Create “" + term + "”", {
              size: "sm",
              variant: "soft",
              icon: "plus",
              onClick: () => createQuickCustomer(term),
            })));
          return;
        }
        for (const customer of items) {
          results.appendChild(h("button", {
            class: "list__row",
            type: "button",
            style: { borderRadius: "8px", width: "100%", textAlign: "left", border: "1px solid var(--border)" },
            onClick: () => {
              state.customer = customer;
              state.redeem = 0;
              instance.close();
              renderCart();
            },
          },
          h("div", { class: "avatar avatar--sm", style: { background: "#5b5bd6" } }, customer.name.slice(0, 2).toUpperCase()),
          h("div", { class: "grow", style: { minWidth: 0 } },
            h("div", { class: "strong small truncate" }, customer.name),
            h("div", { class: "tiny dim truncate" }, customer.phone || customer.email || "No contact")),
          customer.loyalty_points ? badge(`${customer.loyalty_points} pts`, "primary") : null));
        }
      } catch (error) {
        results.appendChild(alertBox(error.message, "danger"));
      }
    }, 220);

    input.addEventListener("input", search);
    const instance = modal({
      title: "Attach a customer",
      subtitle: "Loyalty points and history follow the customer",
      body: h("div", { class: "col gap-3" }, errorHost, body),
      footer: [
        button("New customer", { icon: "plus", onClick: () => createQuickCustomer(input.value.trim()) }),
        button("Done", { variant: "primary", onClick: () => instance.close() }),
      ],
    });
    search();

    async function createQuickCustomer(name) {
      if (!name) {
        toast("Enter a name first.", "warning");
        return;
      }
      try {
        const { item } = await post("/customers", { name, phone: /^\d/.test(name) ? name : "" });
        state.customer = item;
        toast(`${item.name} added.`, "success");
        instance.close();
        renderCart();
      } catch (error) {
        clear(errorHost);
        errorHost.appendChild(alertBox(error.message, "danger"));
      }
    }
  }

  function openLineNote(line) {
    const presets = (state.config.order_notes || {}).quick_notes || [];
    const chips = h("div", { class: "chips" });
    const input = textarea({ value: line.note || "", rows: 2, placeholder: "e.g. extra hot, no sugar" });
    for (const preset of presets) {
      chips.appendChild(h("button", {
        class: "chip",
        type: "button",
        onClick: () => { input.value = preset; input.focus(); },
      }, preset));
    }
    const instance = modal({
      title: "Item note",
      subtitle: line.product.name,
      size: "sm",
      body: h("div", { class: "col gap-3" }, presets.length ? chips : null, field({ label: "Note", control: input })),
      footer: [
        button("Clear", { variant: "ghost", onClick: () => { line.note = ""; instance.close(); renderCart(); } }),
        button("Save note", { variant: "primary", onClick: () => { line.note = input.value.trim(); instance.close(); renderCart(); } }),
      ],
    });
  }

  function openPriceOverride(line) {
    const cfg = state.config.price_overrides || {};
    const limit = Math.max(0, Number(cfg.max_percent_below ?? 100));
    const floor = Math.round(line.product.price_cents * (1 - limit / 100));
    const priceInput = moneyInput({ value: (line.unitPrice / 100).toFixed(2) });
    const pinInput = textInput({ type: "password", placeholder: "Manager PIN", maxlength: "12" });
    const errorHost = h("div");
    const instance = modal({
      title: "Change the line price",
      subtitle: `${line.product.name} · list ${money(line.product.price_cents)}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({
          label: "Price",
          control: priceInput,
          hint: limit < 100 ? `Lowest allowed ${money(floor)} (${limit}% below list)` : "No limit set",
        }),
        cfg.require_pin ? field({ label: "Manager PIN", control: pinInput, hint: "A supervisor with override rights must approve." }) : null),
      footer: [
        button("Reset to list price", { variant: "ghost", onClick: () => {
          line.unitPrice = line.product.price_cents;
          line.overridePin = "";
          instance.close();
          renderCart();
        } }),
        button("Cancel", { onClick: () => instance.close() }),
        button("Apply price", { variant: "primary", onClick: () => {
          const cents = Math.round((Number(priceInput.value) || 0) * 100);
          clear(errorHost);
          if (cents <= 0) {
            errorHost.appendChild(alertBox("Enter a price above zero.", "danger"));
            return;
          }
          if (cents < floor) {
            errorHost.appendChild(alertBox(`This price is more than ${limit}% below the list price.`, "danger"));
            return;
          }
          if (cfg.require_pin && !pinInput.value.trim()) {
            errorHost.appendChild(alertBox("A manager PIN is required for a price override.", "danger"));
            return;
          }
          line.unitPrice = cents;
          line.overridePin = cfg.require_pin ? pinInput.value.trim() : "";
          instance.close();
          renderCart();
        } }),
      ],
    });
  }

  /* --------------------------------------------------------------------- */
  /* Discount / tip / points                                                */
  /* --------------------------------------------------------------------- */
  function openDiscountModal() {
    const cfg = state.config.discounts || {};
    let type = state.discount?.type || "percent";
    const valueInput = moneyInput({ value: state.discount ? (state.discount.type === "percent" ? state.discount.value : state.discount.value / 100) : "" });
    const codeInput = textInput({ placeholder: "Promotion code", value: state.discount?.code || "" });
    const errorHost = h("div");

    const typeSwitch = h("div", { class: "segmented" },
      h("button", { class: `segmented__item${type === "percent" ? " is-active" : ""}`, type: "button", onClick: (e) => {
        type = "percent";
        [...e.currentTarget.parentElement.children].forEach((btn) => btn.classList.remove("is-active"));
        e.currentTarget.classList.add("is-active");
        valueInput.placeholder = "10";
      } }, "Percentage"),
      h("button", { class: `segmented__item${type === "fixed" ? " is-active" : ""}`, type: "button", onClick: (e) => {
        type = "fixed";
        [...e.currentTarget.parentElement.children].forEach((btn) => btn.classList.remove("is-active"));
        e.currentTarget.classList.add("is-active");
        valueInput.placeholder = "5.00";
      } }, "Fixed amount"));

    const instance = modal({
      title: "Apply a discount",
      size: "sm",
      body: h("div", { class: "col gap-3" },
        errorHost,
        typeSwitch,
        field({ label: "Amount", control: valueInput, hint: type === "percent" ? `Maximum ${cfg.max_manual_percent ?? 100}%` : "Amount off the whole sale" }),
        cfg.require_code ? null : field({ label: "Promotion code (optional)", control: codeInput })),
      footer: [
        state.discount ? button("Remove", { variant: "ghost", danger: true, onClick: () => { state.discount = null; instance.close(); renderCart(); } }) : null,
        button("Cancel", { onClick: () => instance.close() }),
        button("Apply", { variant: "primary", onClick: apply }),
      ],
    });

    function apply() {
      clear(errorHost);
      if (codeInput.value.trim()) {
        const code = codeInput.value.trim().toUpperCase();
        post("/discounts/validate", { code })
          .then(({ item }) => {
            state.discount = { type: item.type, value: item.value, label: item.name, code };
            instance.close();
            renderCart();
          })
          .catch((error) => {
            errorHost.appendChild(alertBox(error.message, "danger"));
          });
        return;
      }
      const raw = Number(valueInput.value);
      if (!raw || raw <= 0) {
        errorHost.appendChild(alertBox("Enter a discount amount.", "danger"));
        return;
      }
      if (type === "percent" && raw > (cfg.max_manual_percent ?? 100)) {
        errorHost.appendChild(alertBox(`Manual discounts are capped at ${cfg.max_manual_percent}%.`, "danger"));
        return;
      }
      state.discount = type === "percent"
        ? { type: "percent", value: raw, label: `Discount ${raw}%` }
        : { type: "fixed", value: Math.round(raw * 100), label: "Manual discount" };
      instance.close();
      renderCart();
    }
  }

  function openTipModal() {
    const tipsCfg = state.config.tips || {};
    const presets = tipsCfg.presets || [5, 10, 15];
    const allowCustom = tipsCfg.allow_custom !== false;
    const totals = computeTotals();
    const chips = h("div", { class: "chips" });
    const custom = moneyInput({ placeholder: "Custom amount" });
    for (const percent of presets) {
      chips.appendChild(h("button", {
        class: "chip",
        type: "button",
        onClick: () => {
          state.tip = Math.round((totals.net * Number(percent)) / 100);
          instance.close();
          renderCart();
        },
      }, `${percent}% · ${money(Math.round((totals.net * Number(percent)) / 100))}`));
    }
    const instance = modal({
      title: "Add a tip",
      size: "sm",
      body: h("div", { class: "col gap-3" }, chips,
        allowCustom ? field({ label: "Custom tip", control: custom }) : null),
      footer: [
        state.tip ? button("Remove tip", { variant: "ghost", danger: true, onClick: () => { state.tip = 0; instance.close(); renderCart(); } }) : null,
        button("Cancel", { onClick: () => instance.close() }),
        allowCustom ? button("Add tip", { variant: "primary", onClick: () => {
          state.tip = Math.round((Number(custom.value) || 0) * 100);
          instance.close();
          renderCart();
        } }) : null,
      ],
    });
  }

  function openRedeemModal() {
    const cfg = state.config.loyalty || {};
    const available = state.customer?.loyalty_points || 0;
    const unit = Number(cfg.redeem_value || 0);
    const minimum = Math.max(0, Number(cfg.minimum_redeem || 0));
    const input = textInput({ type: "number", min: String(minimum), max: String(available), value: String(state.redeem || "") });
    const errorHost = h("div");
    const instance = modal({
      title: "Redeem loyalty points",
      subtitle: state.customer?.name,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        alertBox(`${available} points available · 1 point = ${money(unit)}`, "info"),
        field({ label: "Points to redeem", control: input, hint: minimum ? `Minimum ${minimum} points` : "Any amount" })),
      footer: [
        button("Cancel", { onClick: () => instance.close() }),
        button("Redeem", { variant: "primary", onClick: () => {
          const points = Math.min(available, Math.max(0, Number(input.value) || 0));
          if (points > 0 && points < minimum) {
            clear(errorHost);
            errorHost.appendChild(alertBox(`Redeem at least ${minimum} points.`, "danger"));
            return;
          }
          state.redeem = points;
          instance.close();
          renderCart();
        } }),
      ],
    });
  }

  /* --------------------------------------------------------------------- */
  /* Holds                                                                  */
  /* --------------------------------------------------------------------- */
  async function saveHold() {
    if (!state.cart.length) return;
    const name = state.customer ? `${state.customer.name} · ${state.cart.length} items` : `Held order · ${date(new Date())}`;
    try {
      await post("/holds", {
        name,
        payload: {
          cart: state.cart.map((line) => ({
            product_id: line.product.id,
            qty: line.qty,
            unit_price_cents: line.unitPrice,
            discount_cents: line.discount,
            note: line.note,
          })),
          customer_id: state.customer?.id || null,
          discount: state.discount,
          note: state.note,
          tip: state.tip,
          redeem: state.redeem,
        },
      });
      toast("Order parked. Resume it from Held orders.", "success");
      clearCart();
      state.holds = (await get("/holds")).items;
      renderLeft();
      renderCart();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openHolds() {
    const body = h("div", { class: "col gap-2" });
    if (!state.holds.length) {
      body.appendChild(emptyState({
        icon: "pause",
        title: "No held orders",
        text: "Press Hold while a cart is open to park it here. Resumed carts keep their items, discounts and notes.",
      }));
    } else {
      body.appendChild(h("div", { class: "small muted" },
        `${state.holds.length} parked cart${state.holds.length === 1 ? "" : "s"} · resume one to finish and charge it`));
    }
    for (const hold of state.holds) {
      const payload = hold.payload || {};
      const lines = Array.isArray(payload.cart) ? payload.cart : [];
      const total = lines.reduce((sum, line) => sum + (line.unit_price_cents ?? 0) * (line.qty || 1), 0);
      const summary = lines
        .slice(0, 3)
        .map((line) => {
          const product = state.products.find((entry) => entry.id === line.product_id);
          return `${product?.name || "Item"} ×${fmtQty(line.qty || 1)}`;
        })
        .join(", ");
      body.appendChild(h("div", { class: "card card--pad" },
        h("div", { class: "flex items-center gap-2" },
          h("div", { class: "grow", style: { minWidth: 0 } },
            h("div", { class: "strong truncate" }, hold.name),
            h("div", { class: "tiny dim" }, `${hold.user} · ${date(hold.created_at)} · ${lines.length} line${lines.length === 1 ? "" : "s"}`)),
          h("div", { class: "num strong" }, money(total))),
        summary
          ? h("div", { class: "small muted mt-1", style: { overflowWrap: "anywhere" } },
            summary + (lines.length > 3 ? ` +${lines.length - 3} more` : ""))
          : null,
        h("div", { class: "flex gap-2 mt-2" },
          button("Resume & charge", {
            size: "sm",
            variant: "primary",
            icon: "cart",
            onClick: () => { resume(hold, { charge: true }); },
          }),
          button("Discard", {
            size: "sm",
            variant: "ghost",
            onClick: async () => {
              await del(`/holds/${hold.id}`);
              state.holds = state.holds.filter((entry) => entry.id !== hold.id);
              instance.close();
              openHolds();
            },
          }))));
    }
    const instance = drawer({
      title: "Held orders",
      subtitle: "Parked carts wait here until you finish them",
      body,
    });
  }

  function resume(hold, { charge = false } = {}) {
    const payload = hold.payload || {};
    const cart = [];
    for (const raw of payload.cart || []) {
      const product = state.products.find((entry) => entry.id === raw.product_id);
      if (!product) continue;
      cart.push({
        product,
        qty: raw.qty || 1,
        unitPrice: raw.unit_price_cents ?? product.price_cents,
        discount: raw.discount_cents || 0,
        note: raw.note || "",
      });
    }
    state.cart = cart;
    state.discount = payload.discount || null;
    state.note = payload.note || "";
    state.tip = payload.tip || 0;
    state.redeem = payload.redeem || 0;
    if (payload.customer_id) {
      get(`/customers/${payload.customer_id}`)
        .then(({ item }) => { state.customer = item; renderCart(); })
        .catch(() => {});
    }
    del(`/holds/${hold.id}`).catch(() => {});
    state.holds = state.holds.filter((entry) => entry.id !== hold.id);
    document.querySelectorAll(".overlay").forEach((node) => node.remove());
    renderLeft();
    renderCart();
    if (charge && state.cart.length) {
      openPayment();
    } else {
      toast("Order resumed — it is back in the cart.", "success");
    }
  }

  /* --------------------------------------------------------------------- */
  /* Payments                                                               */
  /* --------------------------------------------------------------------- */
  function openPayment() {
    let totals = computeTotals();
    if (!state.cart.length) return;
    const payments = [];
    let selectedMethod = state.methods[0] || null;
    let pendingAmount = totals.total;
    let reference = "";

    const errorHost = h("div");
    const methodGrid = h("div", { class: "pay-grid" });
    const paymentsList = h("div", { class: "col gap-1" });
    const dueLabel = h("span", {}, "Still due");
    const dueValue = h("span", { class: "num" }, money(0));
    const dueBlock = h("div", { class: "change-due", style: { background: "var(--surface-3)", color: "var(--text)" } }, dueLabel, dueValue);
    const amountInput = moneyInput({ value: "", placeholder: "0.00" });
    const referenceInput = textInput({ placeholder: "Reference / auth code" });
    const referenceField = field({ label: "Reference", control: referenceInput });
    const quickCash = h("div", { class: "quick-cash" });
    const submit = button("Complete sale", { variant: "primary", size: "lg", block: true, icon: "check" });
    const addButton = button("Add payment", { icon: "plus", size: "sm" });

    function paidTotal() {
      return payments.reduce((sum, entry) => sum + entry.amount_cents, 0);
    }

    function remaining() {
      return Math.max(0, totals.total - paidTotal());
    }

    function tenderedCents() {
      return Math.max(0, Math.round((Number(amountInput.value) || 0) * 100));
    }

    function tenderedChange() {
      return Math.max(0, paidTotal() + tenderedCents() - totals.total);
    }

    function updatePreview() {
      const due = remaining();
      const entered = tenderedCents();
      const change = tenderedChange();
      const outstanding = Math.max(0, due - entered);
      const isCash = !selectedMethod || selectedMethod.type === "cash";
      const overpayBlocked = entered > due && due > 0 && !isCash;

      if (change > 0) {
        dueLabel.textContent = "Change due";
        dueValue.textContent = money(change);
        dueBlock.style.background = "color-mix(in srgb, var(--success) 12%, transparent)";
        dueBlock.style.color = "var(--success)";
      } else if (overpayBlocked) {
        dueLabel.textContent = "Over the balance";
        dueValue.textContent = money(entered - due);
        dueBlock.style.background = "var(--danger-soft)";
        dueBlock.style.color = "var(--danger)";
      } else if (due > 0 && outstanding === 0) {
        dueLabel.textContent = "Ready to complete";
        dueValue.textContent = money(0);
        dueBlock.style.background = "color-mix(in srgb, var(--success) 12%, transparent)";
        dueBlock.style.color = "var(--success)";
      } else if (due > 0) {
        dueLabel.textContent = "Still due";
        dueValue.textContent = money(outstanding);
        dueBlock.style.background = "var(--warning-soft)";
        dueBlock.style.color = "var(--warning)";
      } else {
        dueLabel.textContent = "Paid in full";
        dueValue.textContent = money(0);
        dueBlock.style.background = "color-mix(in srgb, var(--success) 12%, transparent)";
        dueBlock.style.color = "var(--success)";
      }

      submit.disabled = overpayBlocked;
      addButton.disabled = due <= 0;
      const label = submit.querySelector("span");
      if (change > 0) {
        label.textContent = `Complete sale · change ${money(change)}`;
      } else if (overpayBlocked) {
        label.textContent = `Complete sale · ${money(due)} due`;
      } else if (outstanding > 0) {
        label.textContent = `Complete sale · ${money(outstanding)} still due`;
      } else {
        label.textContent = `Complete sale · ${money(totals.total)}`;
      }
    }

    function refresh() {
      clear(methodGrid);
      for (const method of state.methods) {
        const active = selectedMethod && selectedMethod.id === method.id;
        methodGrid.appendChild(h("button", {
          class: `pay-method${active ? " is-active" : ""}`,
          type: "button",
          onClick: () => {
            selectedMethod = method;
            amountInput.value = (remaining() / 100).toFixed(2);
            referenceField.classList.toggle("hidden", !method.requires_reference);
            refresh();
          },
        }, icon(method.icon || "cash"), h("span", {}, method.name)));
      }

      clear(quickCash);
      const quick = (state.config.pos || {}).quick_cash || [];
      for (const amount of quick) {
        quickCash.appendChild(h("button", {
          type: "button",
          onClick: () => {
            const value = Number(amount);
            amountInput.value = (value / 100).toFixed(2);
            updatePreview();
          },
        }, money(Number(amount))));
      }
      quickCash.appendChild(h("button", {
        type: "button",
        onClick: () => { amountInput.value = (remaining() / 100).toFixed(2); updatePreview(); },
      }, "Exact"));

      clear(paymentsList);
      for (const [index, entry] of payments.entries()) {
        paymentsList.appendChild(h("div", { class: "flex items-center gap-2", style: { padding: "6px 0", borderBottom: "1px solid var(--border)" } },
          h("span", { class: "grow" },
            h("div", { class: "small" }, entry.method_name),
            entry.change_cents
              ? h("div", { class: "tiny dim" }, `Change ${money(entry.change_cents)}`)
              : null),
          h("span", { class: "num small strong" }, money(entry.amount_cents)),
          iconButton("x", { size: "sm", variant: "ghost", danger: true, onClick: () => {
            payments.splice(index, 1);
            refresh();
          } })));
      }

      updatePreview();
    }

    addButton.addEventListener("click", () => {
      if (!selectedMethod) return;
      const amount = Math.round((Number(amountInput.value) || 0) * 100);
      if (amount <= 0) {
        toast("Enter an amount.", "warning");
        return;
      }
      const due = remaining();
      if (due <= 0) {
        toast("This sale is already paid in full.", "warning");
        return;
      }
      if (amount > due && selectedMethod.type !== "cash") {
        toast(`${selectedMethod.name} cannot exceed the ${money(due)} still due.`, "warning");
        return;
      }
      if (selectedMethod.requires_reference && !referenceInput.value.trim()) {
        toast(`${selectedMethod.name} needs a reference.`, "warning");
        return;
      }
      payments.push({
        method_id: selectedMethod.id,
        method_name: selectedMethod.name,
        amount_cents: amount,
        tendered_cents: amount,
        change_cents: Math.max(0, amount - due),
        reference: referenceInput.value.trim(),
      });
      referenceInput.value = "";
      amountInput.value = (remaining() / 100).toFixed(2);
      refresh();
    });

    submit.addEventListener("click", async () => {
      if (!selectedMethod) {
        toast("Choose a payment method.", "warning");
        return;
      }
      const due = remaining();
      if (due > 0) {
        const amount = tenderedCents();
        if (amount > due && selectedMethod.type !== "cash") {
          clear(errorHost);
          errorHost.appendChild(alertBox(
            `${selectedMethod.name} cannot exceed the ${money(due)} still due.`, "danger"));
          return;
        }
        if (amount > 0) {
          payments.push({
            method_id: selectedMethod.id,
            method_name: selectedMethod.name,
            amount_cents: amount,
            tendered_cents: amount,
            change_cents: Math.max(0, amount - due),
            reference: referenceInput.value.trim(),
          });
        }
      }
      if (paidTotal() < totals.total) {
        clear(errorHost);
        errorHost.appendChild(alertBox(`Collect ${money(totals.total - paidTotal())} more to complete the sale.`, "danger"));
        return;
      }
      submit.setLoading(true);
      clear(errorHost);
      const salePayload = {
        lines: state.cart.map((line) => ({
          product_id: line.product.id,
          qty: line.qty,
          unit_price_cents: line.unitPrice,
          override_pin: line.overridePin || "",
          discount_cents: line.discount || 0,
          note: line.note || "",
        })),
        payments: payments.map((entry) => ({
          method_id: entry.method_id,
          amount_cents: entry.amount_cents,
          tendered_cents: entry.tendered_cents,
          reference: entry.reference,
        })),
        customer_id: state.customer?.id || null,
        discount: state.discount
          ? (state.discount.code ? { code: state.discount.code } : { type: state.discount.type, value: state.discount.type === "percent" ? state.discount.value : state.discount.value })
          : null,
        tip_cents: state.tip,
        redeem_points: state.redeem,
        note: state.note,
        shift_id: state.shift?.id || null,
        location_id: state.locationId,
        register_id: state.registers.find((row) => row.location_id === state.locationId)?.id || null,
      };
      try {
        const { item } = await post("/sales", salePayload);
        paymentModal.close();
        clearCart();
        state.lastSale = item;
        showSuccess(item);
        await load();
      } catch (error) {
        // No connection: keep the sale here and push it once the till is back online.
        if (error.code === "network" && await offerOfflineSave({
          path: "/sales",
          body: salePayload,
          label: `Sale · ${money(totals.total)} · ${number(totals.itemCount, 0)} item${totals.itemCount === 1 ? "" : "s"}`,
        })) {
          for (const line of state.cart) {
            const product = state.products.find((row) => row.id === line.product.id);
            if (product && product.track_stock) {
              product.stock_qty = Math.max(0, Number(product.stock_qty || 0) - line.qty);
            }
          }
          paymentModal.close();
          clearCart();
          renderGrid();
          showOfflineSale(totals);
          return;
        }
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        submit.setLoading(false);
      }
    });

    const paymentModal = modal({
      title: "Take payment",
      subtitle: `${number(totals.itemCount, 0)} ${totals.itemCount === 1 ? "item" : "items"} · ${money(totals.total)}`,
      size: "md",
      body: h("div", { class: "col gap-3" },
        errorHost,
        methodGrid,
        paymentsList,
        h("div", { class: "flex gap-2 items-end" }, field({ label: "Amount", control: amountInput }), addButton),
        quickCash,
        referenceField,
        dueBlock),
      footer: [button("Cancel", { onClick: () => paymentModal.close() }), submit],
    });
    amountInput.value = (totals.total / 100).toFixed(2);
    amountInput.addEventListener("input", updatePreview);
    referenceField.classList.toggle("hidden", !selectedMethod?.requires_reference);
    refresh();
  }

  function showOfflineSale(totals) {
    let instance;
    instance = modal({
      title: "Sale saved offline",
      subtitle: `${money(totals.total)} · ${number(totals.itemCount, 0)} item${totals.itemCount === 1 ? "" : "s"}`,
      size: "sm",
      body: h("div", { class: "col gap-3 center" },
        h("div", {
          class: "module-card__icon",
          style: { margin: "0 auto", width: "46px", height: "46px", background: "var(--warning-soft, rgba(245,158,11,.14))", color: "var(--warning, #f59e0b)" },
        }, icon("clock")),
        h("div", { class: "small" }, "This till cannot reach the cloud right now. The sale is safe on this device."),
        h("div", { class: "small dim" },
          "Push it to the cloud from the status pill at the bottom of the screen once you are back online.")),
      footer: [button("Done", { variant: "primary", onClick: () => instance.close() })],
    });
  }

  function showSuccess(sale) {
    const instance = modal({
      title: "Sale complete",
      subtitle: `${sale.number} · ${sale.customer || "Walk-in"}`,
      size: "sm",
      body: h("div", { class: "col gap-3 center" },
        h("div", { class: "module-card__icon", style: { margin: "0 auto", width: "46px", height: "46px", background: "var(--success-soft)", color: "var(--success)" } }, icon("check")),
        h("div", { class: "kpi__value" }, money(sale.total_cents)),
        sale.change_cents ? h("div", { class: "change-due" }, h("span", {}, "Change due"), h("span", { class: "num" }, money(sale.change_cents))) : null,
        h("div", { class: "small dim" }, `${number(sale.item_count, 0)} items · ${sale.payments.map((p) => p.method_name).join(" + ")}`)),
      footer: [
        button("Receipt", { icon: "print", onClick: () => printReceipt(sale.id) }),
        button("New sale", { variant: "primary", icon: "plus", onClick: () => instance.close() }),
      ],
    });
    if (AUTO_PRINT()) printReceipt(sale.id);
    const openedDrawer = (sale.payments || []).some((payment) => payment.opens_drawer);
    if (openedDrawer) {
      window.dispatchEvent(new CustomEvent("pos:drawer-open", { detail: { saleId: sale.id } }));
      toast("Cash drawer opened.", "info");
    }
  }

  function openBranchMenu(anchor) {
    menu(anchor, state.locations.map((branch) => ({
      label: `${branch.name}${branch.is_default ? " (default)" : ""}`,
      icon: "map",
      onClick: () => {
        state.locationId = branch.id;
        setBranchScope(branch.id);
        toast(`Selling from ${branch.name}.`, "info");
        renderLeft();
      },
    })));
  }

  /* --------------------------------------------------------------------- */
  /* Lay-by                                                                 */
  /* --------------------------------------------------------------------- */
  function openLaybyModal() {
    if (!state.customer) {
      toast("Lay-bys need a registered customer - attach one first.", "warning");
      openCustomerPicker();
      return;
    }
    const totals = computeTotals();
    const cfg = state.config.layby || {};
    const minimum = Math.max(Number(cfg.min_deposit || 0), Math.round((totals.total * Number(cfg.deposit_percent || 0)) / 100));
    const deposit = moneyInput({ value: (minimum / 100).toFixed(2) });
    const dueDate = h("input", {
      class: "input",
      type: "date",
      value: isoDay(addDays(Math.min(Number(cfg.max_days || 90), 30))),
      min: isoDay(addDays(1)),
    });
    const method = select({
      value: state.methods[0]?.id || "",
      options: state.methods.map((row) => ({ value: row.id, label: row.name })),
    });
    const note = textInput({ placeholder: "Agreement note (optional)" });
    const errorHost = h("div");
    const submit = button("Create lay-by", { variant: "primary", icon: "wallet" });
    submit.addEventListener("click", async () => {
      submit.setLoading(true);
      clear(errorHost);
      try {
        const { item } = await post("/laybys", {
          customer_id: state.customer.id,
          lines: state.cart.map((line) => ({
            product_id: line.product.id,
            qty: line.qty,
            unit_price_cents: line.unitPrice,
          })),
          deposit_amount: deposit.value,
          due_date: dueDate.value,
          payment_method_id: method.value ? Number(method.value) : null,
          note: note.value.trim(),
        });
        laybyModal.close();
        clearCart();
        toast(`Lay-by ${item.number} created · ${money(item.balance_cents)} still due.`, "success");
        const print = await confirmDialog({
          title: "Print the lay-by statement?",
          message: `Deposit ${money(item.deposit_cents)} received from ${item.customer}. Balance ${money(item.balance_cents)} due by ${date(item.due_date)}.`,
          confirmLabel: "Print statement",
          cancelLabel: "Not now",
        });
        if (print) window.open(`/api/laybys/${item.id}/statement`, "_blank", "width=440,height=800");
        await load();
      } catch (error) {
        errorHost.appendChild(alertBox(error.message, "danger"));
      } finally {
        submit.setLoading(false);
      }
    });
    const laybyModal = modal({
      title: "Start a lay-by",
      subtitle: `${state.customer.name} · ${money(totals.total)} of goods`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        h("div", { class: "change-due" }, h("span", {}, "Goods reserved"), h("span", { class: "num" }, money(totals.total))),
        field({ label: "Deposit today", control: deposit, required: true, hint: `Minimum ${money(minimum)} (${cfg.deposit_percent || 0}%)` }),
        field({ label: "Deposit method", control: method }),
        field({ label: "Collect by", control: dueDate, required: true }),
        field({ label: "Note", control: note })),
      footer: [button("Cancel", { onClick: () => laybyModal.close() }), submit],
    });
  }

  /* --------------------------------------------------------------------- */
  /* Shifts                                                                 */
  /* --------------------------------------------------------------------- */
  function openShiftModal() {
    const floatInput = moneyInput({ value: "0.00" });
    const notes = textarea({ rows: 2, placeholder: "Opening notes (optional)" });
    const instance = modal({
      title: "Open cash drawer",
      subtitle: "Count the float before you start selling",
      size: "sm",
      body: h("div", { class: "col gap-3" },
        field({ label: "Opening float", control: floatInput }),
        field({ label: "Notes", control: notes })),
      footer: [button("Cancel", { onClick: () => instance.close() }),
        button("Open drawer", { variant: "primary", onClick: async () => {
          try {
            await post("/shifts/open", {
              opening_float: Number(floatInput.value) || 0,
              notes: notes.value,
              register_id: state.registers.find((row) => row.location_id === state.locationId)?.id || null,
            });
            instance.close();
            const data = await get("/shifts/current");
            state.shift = data.item;
            toast("Drawer opened.", "success");
            renderLeft();
          } catch (error) {
            toast(error.message, "error");
          }
        } })],
    });
  }

  async function openCloseShift() {
    let summary = {};
    try {
      const data = await get("/shifts/current");
      summary = data.summary || {};
    } catch { /* ignore */ }
    const counted = moneyInput({ placeholder: "0.00" });
    const notes = textarea({ rows: 2, placeholder: "Notes for the day (optional)" });
    const countsRequired = (state.config.shifts || {}).count_payments !== false;
    const instance = modal({
      title: "Close cash drawer",
      subtitle: state.shift ? `Opened ${date(state.shift.opened_at)}` : "",
      size: "sm",
      body: h("div", { class: "col gap-3" },
        h("div", { class: "change-due" }, h("span", {}, "Expected cash"), h("span", { class: "num" }, money(summary.expected_cash_cents || 0))),
        field({ label: "Counted cash", control: counted, hint: countsRequired ? "Required — enter the exact amount counted." : "Optional." }),
        field({ label: "Notes", control: notes })),
      footer: [button("Cancel", { onClick: () => instance.close() }),
        button("Close drawer", { variant: "primary", onClick: async () => {
          try {
            const payload = { notes: notes.value };
            if (counted.value !== "") payload.counted_cash = Number(counted.value) || 0;
            await post(`/shifts/${state.shift.id}/close`, payload);
            instance.close();
            state.shift = null;
            toast("Drawer closed.", "success");
            renderLeft();
          } catch (error) {
            toast(error.message, "error");
          }
        } })],
    });
  }

  function openStaffMenu(anchor) {
    menu(anchor, state.staff.map((member) => ({
      label: member.full_name,
      icon: "user",
      onClick: () => switchCashier(member),
    })));
  }

  async function switchCashier(member) {
    const pin = textInput({ type: "password", placeholder: "Enter PIN", autofocus: true });
    const errorHost = h("div");
    const instance = modal({
      title: `Switch to ${member.full_name}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, field({ label: "PIN", control: pin })),
      footer: [button("Cancel", { onClick: () => instance.close() }),
        button("Switch", { variant: "primary", onClick: async () => {
          try {
            const session = await post("/auth/switch-user", { user_id: member.id, pin: pin.value });
            store.set({ session, csrf: session.csrf_token });
            toast(`Terminal handed to ${member.full_name}.`, "success");
            setTimeout(() => window.location.reload(), 400);
          } catch (error) {
            errorHost.appendChild(alertBox(error.message, "danger"));
          }
        } })],
    });
  }

  /* --------------------------------------------------------------------- */
  /* Keyboard shortcuts                                                     */
  /* --------------------------------------------------------------------- */
  function onKeyDown(e) {
    if (!el.isConnected) return;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (e.key === "F2") {
      e.preventDefault();
      el.querySelector("[data-pos-search]")?.focus();
    }
    if (e.key === "F4") {
      e.preventDefault();
      openCustomerPicker();
    }
    if (e.ctrlKey && e.key === "Enter" && !typing) {
      e.preventDefault();
      if (state.cart.length) openPayment();
    }
    if (e.key === "Escape" && !typing) {
      const search = el.querySelector("[data-pos-search]");
      if (search && search.value) {
        search.value = "";
        state.search = "";
        renderGrid();
      }
    }
  }
  document.addEventListener("keydown", onKeyDown);
  load().catch((error) => {
    loadingSkeleton.remove();
    el.classList.remove("is-loading");
    clear(el);
    el.appendChild(alertBox(error.message, "danger"));
  });

  return {
    el,
    destroy: () => {
      document.removeEventListener("keydown", onKeyDown);
    },
    onActivate: () => {
      const search = el.querySelector("[data-pos-search]");
      if (search) search.focus({ preventScroll: true });
    },
  };
}
