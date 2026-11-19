/* UI kit: buttons, fields, modals, drawers, toasts, tables, menus. */

import { h, clear, frag } from "./dom.js";
import { icon } from "./icons.js";
import { money as fmtMoney, initials } from "./fmt.js";

/* ---------- buttons ------------------------------------------------------- */
export function button(label, { variant = "", size = "", icon: iconName, onClick, disabled, title, type = "button",
  block, id, loading, attrs = {} } = {}) {
  const classes = ["btn"];
  if (variant) classes.push(`btn--${variant}`);
  if (size) classes.push(`btn--${size}`);
  if (block) classes.push("btn--block");
  if (loading) classes.push("is-loading");
  const el = h("button", {
    class: classes.join(" "),
    type,
    disabled: disabled || loading,
    title,
    id,
    attrs,
    onClick,
  });
  if (iconName) el.appendChild(icon(iconName));
  if (label) el.appendChild(h("span", {}, label));
  el.setLoading = (state) => {
    el.classList.toggle("is-loading", Boolean(state));
    el.disabled = Boolean(state) || disabled;
  };
  return el;
}

export function iconButton(iconName, { size = "", variant = "", onClick, title, disabled, danger, attrs = {} } = {}) {
  const classes = ["iconbtn"];
  if (size) classes.push(`iconbtn--${size}`);
  if (variant) classes.push(`iconbtn--${variant}`);
  if (danger) classes.push("iconbtn--danger");
  const el = h("button", { class: classes.join(" "), type: "button", title, disabled, attrs, onClick });
  el.appendChild(icon(iconName));
  return el;
}

/* ---------- fields -------------------------------------------------------- */
export function field({ label, hint, required, error, control, span = false, id = "" } = {}) {
  const wrap = h("label", { class: `field${span ? " span-2" : ""}`, for: id, attrs: { "data-field-wrap": id || "" } });
  if (label) {
    wrap.appendChild(
      h("span", { class: "field__label" }, label, required ? h("span", { class: "req" }, "*") : null)
    );
  }
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h("span", { class: "field__hint" }, hint));
  if (error) wrap.appendChild(h("span", { class: "field__error" }, error));
  wrap.dataset.field = id;
  return wrap;
}

export function textInput({ value = "", placeholder, type = "text", name, id, disabled, autofocus, min, max, step,
  maxlength, onInput, onChange, attrs = {}, className = "" } = {}) {
  return h("input", {
    class: `input ${className}${type === "number" ? " num" : ""}`,
    type,
    value: value ?? "",
    placeholder,
    name,
    id,
    disabled,
    autofocus,
    min,
    max,
    step,
    maxlength,
    attrs,
    onInput,
    onChange,
  });
}

export function moneyInput({ value, ...rest } = {}) {
  return textInput({ type: "number", step: "0.01", min: "0", value: value ?? "", ...rest });
}

export function textarea({ value = "", placeholder, rows = 3, name, id, maxlength, onInput, disabled } = {}) {
  return h("textarea", { class: "textarea", placeholder, rows, name, id, maxlength, onInput, disabled, value });
}

export function select({ value, options = [], name, id, onChange, disabled, placeholder } = {}) {
  const el = h("select", { class: "select", name, id, disabled, onChange });
  if (placeholder) el.appendChild(h("option", { value: "" }, placeholder));
  for (const option of options) {
    const normalized = typeof option === "object" ? option : { value: option, label: String(option) };
    el.appendChild(
      h("option", { value: normalized.value, selected: String(normalized.value) === String(value ?? "") },
        normalized.label)
    );
  }
  return el;
}

export function switchControl({ checked = false, onChange, label, size = "", id, disabled = false } = {}) {
  const input = h("input", {
    type: "checkbox",
    checked,
    id,
    disabled,
    onChange: (e) => onChange?.(e.target.checked, e),
  });
  const el = h("label", { class: `switch${size === "lg" ? " switch--lg" : ""}${disabled ? " is-disabled" : ""}` }, input,
    h("span", { class: "switch__track" }), label ? h("span", { class: "switch__label" }, label) : null);
  el.input = input;
  el.setChecked = (value) => { input.checked = Boolean(value); };
  el.setDisabled = (value) => {
    input.disabled = Boolean(value);
    el.classList.toggle("is-disabled", Boolean(value));
  };
  return el;
}

export function checkbox({ checked = false, onChange, label } = {}) {
  return h("label", { class: "checkbox" },
    h("input", { type: "checkbox", checked, onChange: (e) => onChange?.(e.target.checked, e) }),
    h("span", {}, label));
}

export function segmented(items, { value, onChange, size } = {}) {
  const el = h("div", { class: "segmented" });
  const buttons = [];
  for (const item of items) {
    const btn = h("button", {
      class: `segmented__item${String(item.value) === String(value) ? " is-active" : ""}`,
      type: "button",
      title: item.title,
      onClick: () => {
        buttons.forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        onChange?.(item.value, item);
      },
    }, item.icon ? icon(item.icon) : null, item.label ? h("span", {}, item.label) : null);
    buttons.push(btn);
    el.appendChild(btn);
  }
  return el;
}

export function switchRow({ title, hint, checked, onChange, disabled, id } = {}) {
  const control = switchControl({ checked, onChange, disabled, id });
  const el = h("div", { class: `switch-row${disabled ? " is-disabled" : ""}` },
    h("div", { class: "switch-row__text" },
      h("div", { class: "switch-row__title" }, title),
      hint ? h("div", { class: "switch-row__hint" }, hint) : null),
    control);
  el.input = control.input;
  el.setChecked = control.setChecked;
  el.setDisabled = control.setDisabled;
  return el;
}

export function tagInput({ values = [], placeholder = "Add…", onChange } = {}) {
  const list = [...values];
  const chips = h("div", { class: "chips" });
  const input = h("input", {
    placeholder,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const raw = input.value.trim().replace(/,$/, "");
        if (!raw) return;
        const numeric = Number(raw);
        list.push(raw !== "" && Number.isFinite(numeric) ? numeric : raw);
        input.value = "";
        renderChips();
        onChange?.(list);
      }
      if (e.key === "Backspace" && !input.value && list.length) {
        list.pop();
        renderChips();
        onChange?.(list);
      }
    },
  });

  function renderChips() {
    clear(chips);
    list.forEach((value, index) => {
      const chip = h("span", {
        class: "chip chip--removable",
        title: "Remove",
        onClick: () => {
          list.splice(index, 1);
          renderChips();
          onChange?.(list);
        },
      }, String(value), icon("x"));
      chips.appendChild(chip);
    });
    chips.appendChild(input);
  }

  renderChips();
  const wrap = h("div", { class: "tag-input" }, chips);
  wrap.getValue = () => [...list];
  return wrap;
}

/* ---------- layout helpers ----------------------------------------------- */
export function sectionCard({ title, subtitle, actions, body, flush = false, id } = {}) {
  return h("section", { class: "card", id },
    (title || actions) ? h("header", { class: "card__head" },
      h("div", {},
        title ? h("div", { class: "card__title" }, title) : null,
        subtitle ? h("div", { class: "card__sub" }, subtitle) : null),
      actions ? h("div", { class: "card__actions" }, actions) : null) : null,
    h("div", { class: `card__body${flush ? " card__body--flush" : ""}` }, body));
}

export function pageHeader({ title, subtitle, actions, back } = {}) {
  return h("div", { class: "page-head" },
    back ? iconButton("chevronLeft", { onClick: back, title: "Back" }) : null,
    h("div", {},
      h("h1", { class: "page-head__title" }, title),
      subtitle ? h("div", { class: "page-head__sub" }, subtitle) : null),
    actions ? h("div", { class: "page-head__actions" }, actions) : null);
}

export function statCard({ label, value, icon: iconName, tone = "", foot, onClick, compact = false } = {}) {
  const el = h("div", {
    class: `kpi${tone ? ` kpi--${tone}` : ""}${compact ? " kpi--compact" : ""}`,
    onClick,
    style: onClick ? { cursor: "pointer" } : null,
  },
    iconName ? h("div", { class: "kpi__icon" }, icon(iconName)) : null,
    h("div", { class: "kpi__label" }, label),
    h("div", { class: "kpi__value" }, value),
    foot ? h("div", { class: "kpi__foot" }, foot) : null);
  return el;
}

export function badge(text, tone = "", { dot = false } = {}) {
  return h("span", { class: `badge${tone ? ` badge--${tone}` : ""}` },
    dot ? h("span", { class: "badge__dot" }) : null, text);
}

const STATUS_TONES = {
  completed: "success",
  refunded: "danger",
  partially_refunded: "warning",
  voided: "danger",
  active: "success",
  trial: "info",
  suspended: "danger",
  disabled: "danger",
  invited: "warning",
  open: "success",
  closed: "",
  receive: "success",
  sale: "info",
  refund: "warning",
  wastage: "danger",
  adjustment: "",
  correction: "warning",
  count: "",
  transfer: "info",
  opening: "info",
  void: "danger",
};

export function statusBadge(status = "") {
  const label = String(status).replace(/_/g, " ");
  return badge(label.charAt(0).toUpperCase() + label.slice(1), STATUS_TONES[status] || "");
}

export function avatar(name, color = "#5b5bd6", size = "") {
  return h("div", {
    class: `avatar${size ? ` avatar--${size}` : ""}`,
    style: { background: color || "#5b5bd6" },
    title: name,
  }, initials(name));
}

export function emptyState({ icon: iconName = "box", title, text, action } = {}) {
  return h("div", { class: "empty" },
    h("div", { class: "empty__icon" }, icon(iconName)),
    title ? h("div", { class: "empty__title" }, title) : null,
    text ? h("div", { class: "empty__text" }, text) : null,
    action || null);
}

export function loadingBlock(label = "Loading", { compact = false } = {}) {
  const block = (width) => h("div", { class: "skeleton", style: { width: `${width}%`, height: "10px" } });
  if (compact) {
    return h("div", { class: "loading-block", attrs: { role: "status", "aria-live": "polite" } },
      h("span", { class: "sr-only" }, label),
      h("div", { class: "page-skeleton page-skeleton--compact", attrs: { "aria-hidden": "true" } },
        block(46), block(72), block(58), block(64)));
  }
  const card = () => h("div", { class: "page-skeleton__card" },
    h("div", { class: "skeleton skeleton--label" }),
    h("div", { class: "skeleton skeleton--value" }));
  return h("div", { class: "loading-block", attrs: { role: "status", "aria-live": "polite" } },
    h("span", { class: "sr-only" }, label),
    h("div", { class: "page-skeleton", attrs: { "aria-hidden": "true" } },
      h("div", { class: "page-skeleton__head" },
        h("div", { class: "page-skeleton__titles" },
          h("div", { class: "skeleton skeleton--title" }),
          h("div", { class: "skeleton skeleton--sub" })),
        h("div", { class: "page-skeleton__actions" },
          h("div", { class: "skeleton skeleton--pill" }),
          h("div", { class: "skeleton skeleton--pill" }))),
      h("div", { class: "page-skeleton__grid" }, card(), card(), card(), card()),
      h("div", { class: "page-skeleton__panel" },
        h("div", { class: "skeleton skeleton--row" }),
        h("div", { class: "skeleton skeleton--row" }),
        h("div", { class: "skeleton skeleton--row" }),
        h("div", { class: "skeleton skeleton--row" }))));
}

export function skeletonRows(count = 5) {
  return h("div", { style: { padding: "14px" } },
    Array.from({ length: count }, () => h("div", { class: "skeleton skeleton--line" })));
}

/* A compact skeleton for panels that sit under an existing toolbar. */
export function skeletonCards({ cards = 4, rows = 4, label = "Loading" } = {}) {
  const card = () => h("div", { class: "page-skeleton__card" },
    h("div", { class: "skeleton skeleton--label" }),
    h("div", { class: "skeleton skeleton--value" }));
  return h("div", { class: "loading-block", attrs: { role: "status", "aria-live": "polite" } },
    h("span", { class: "sr-only" }, label),
    h("div", { class: "page-skeleton page-skeleton--compact", attrs: { "aria-hidden": "true" } },
      h("div", { class: "page-skeleton__grid" }, Array.from({ length: cards }, card)),
      h("div", { class: "page-skeleton__panel" },
        Array.from({ length: rows }, () => h("div", { class: "skeleton skeleton--row" })))));
}

/* ---------- table --------------------------------------------------------- */
export function table({ columns, rows, empty = {}, onRowClick, loading = false, compact = false } = {}) {
  if (loading) return skeletonRows(6);
  const wrap = h("div", { class: "table-wrap" });
  if (!rows || !rows.length) {
    return emptyState({ icon: empty.icon || "box", title: empty.title || "Nothing here yet", text: empty.text,
      action: empty.action });
  }
  const tableEl = h("table", { class: `table${compact ? " table--compact" : ""}` });
  const head = h("tr");
  for (const col of columns) {
    head.appendChild(h("th", {
      class: `${col.align === "right" ? "num" : ""}`,
      style: col.width ? { width: col.width } : null,
    }, col.label));
  }
  tableEl.appendChild(h("thead", {}, head));
  const body = h("tbody");
  rows.forEach((row, index) => {
    const tr = h("tr", {
      class: onRowClick ? "is-clickable" : "",
      tabindex: onRowClick ? 0 : null,
    });
    for (const col of columns) {
      const value = col.render ? col.render(row, index) : row[col.key];
      tr.appendChild(h("td", { class: col.align === "right" ? "num" : "" }, value));
    }
    if (onRowClick) {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button, a, input, select, label")) return;
        onRowClick(row, index);
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target !== tr) return;
        e.preventDefault();
        onRowClick(row, index);
      });
    }
    body.appendChild(tr);
  });
  tableEl.appendChild(body);
  wrap.appendChild(tableEl);
  return wrap;
}

export function pagination(meta, onPage) {

  if (!meta || meta.pages <= 1) {

    if (meta && meta.total) {
      return h("div", { class: "pager" },
        h("span", { class: "pager__info" }, `${meta.total} record${meta.total === 1 ? "" : "s"}`));
    }
    // Callers append this straight into the DOM, so never return ``null``.
    return h("div", { class: "pager", style: { display: "none" } });

  }
  return h("div", { class: "pager" },
    h("span", { class: "pager__info" }, `Page ${meta.page} of ${meta.pages} · ${meta.total} records`),
    h("div", { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
      button("Prev", { size: "sm", disabled: meta.page <= 1, onClick: () => onPage(meta.page - 1) }),
      button("Next", { size: "sm", disabled: meta.page >= meta.pages, onClick: () => onPage(meta.page + 1) })));
}

/* ---------- overlays ------------------------------------------------------ */
const overlayStack = [];
let overlayUid = 0;

/* While a dialog is open the page behind it must not move; only the dialog
   body scrolls. */
function syncOverlayLock() {
  const root = document.documentElement;
  if (overlayStack.length) root.dataset.overlay = "1";
  else delete root.dataset.overlay;
}

function focusables(root) {
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.getClientRects().length > 0);
}

function pushOverlay(entry) {
  overlayStack.push(entry);
  syncOverlayLock();
  const onKey = (e) => {
    if (e.key === "Escape" && entry.dismissible) {
      e.stopPropagation();
      entry.close();
      return;
    }
    if (e.key !== "Tab" || !entry.trap) return;
    const items = focusables(entry.trap);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !entry.trap.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !entry.trap.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  entry.keyHandler = onKey;
  document.addEventListener("keydown", onKey);
}

function popOverlay(entry) {
  const index = overlayStack.indexOf(entry);
  if (index >= 0) overlayStack.splice(index, 1);
  syncOverlayLock();
  document.removeEventListener("keydown", entry.keyHandler);
}

/* Give focus back to whatever opened the dialog once it closes. */
function restoreFocusTo(opener) {
  if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
  opener.focus({ preventScroll: true });
}

/* Footer primary actions submit asynchronously; show a spinner until the modal
   closes (success) or an error alert appears. Explicit setLoading still wins. */
function autoSpinFooter(footEl, bodyEl, isClosed) {
  if (!footEl) return;
  footEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".btn--primary");
    if (!btn || btn.disabled) return;
    setTimeout(() => {
      if (btn.classList.contains("is-loading") || isClosed() || !btn.isConnected) return;
      btn.classList.add("is-loading");
      const finish = () => {
        btn.classList.remove("is-loading");
        observer.disconnect();
        clearTimeout(guard);
      };
      const observer = new MutationObserver(() => {
        if (bodyEl.querySelector(".alert--danger, .alert--warning")) finish();
      });
      observer.observe(bodyEl, { childList: true, subtree: true });
      const guard = setTimeout(finish, 15000);
    }, 0);
  }, true);
}

export function modal({ title, subtitle, body, footer, size = "md", dismissible = true, onClose, icon: iconName } = {}) {
  const overlay = h("div", { class: "overlay" });
  const titleId = `modal-title-${++overlayUid}`;
  const dialog = h("div", {
    class: `modal modal--${size}`,
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
  });
  const head = h("header", { class: "modal__head" },
    iconName ? h("div", { class: "module-card__icon" }, icon(iconName)) : null,
    h("div", { class: "grow" },
      h("div", { class: "modal__title", id: titleId }, title),
      subtitle ? h("div", { class: "modal__sub" }, subtitle) : null),
    h("div", { class: "modal__close" }, iconButton("x", { onClick: () => close(), title: "Close" })));
  const bodyEl = h("div", { class: "modal__body" }, body);
  const footEl = footer ? h("footer", { class: "modal__foot" }, footer) : null;
  dialog.appendChild(head);
  dialog.appendChild(bodyEl);
  if (footEl) dialog.appendChild(footEl);
  overlay.appendChild(dialog);

  const opener = document.activeElement;
  let closed = false;
  const entry = {
    dismissible,
    trap: dialog,
    close: () => close(),
  };
  function close() {
    if (closed) return;
    closed = true;
    popOverlay(entry);
    overlay.remove();
    restoreFocusTo(opener);
    onClose?.();
  }
  autoSpinFooter(footEl, bodyEl, () => closed);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && dismissible) close();
  });
  document.body.appendChild(overlay);
  pushOverlay(entry);
  setTimeout(() => {
    const focusable = dialog.querySelector("input, textarea, select, button");
    if (focusable) focusable.focus({ preventScroll: true });
  }, 40);
  return { el: overlay, dialog, body: bodyEl, footer: footEl, close };
}

export function drawer({ title, subtitle, body, footer, size = "", dismissible = true, onClose } = {}) {
  const overlay = h("div", { class: "overlay drawer-overlay" });
  const titleId = `drawer-title-${++overlayUid}`;
  const panel = h("aside", {
    class: `drawer${size ? ` drawer--${size}` : ""}`,
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
  });
  panel.appendChild(h("header", { class: "drawer__head" },
    h("div", { class: "grow" },
      h("div", { class: "modal__title", id: titleId }, title),
      subtitle ? h("div", { class: "modal__sub" }, subtitle) : null),
    iconButton("x", { onClick: () => close(), title: "Close" })));
  const bodyEl = h("div", { class: "drawer__body" }, body);
  panel.appendChild(bodyEl);
  if (footer) panel.appendChild(h("footer", { class: "drawer__foot" }, footer));
  overlay.appendChild(panel);

  const opener = document.activeElement;
  let closed = false;
  const entry = { dismissible, trap: panel, close: () => close() };
  function close() {
    if (closed) return;
    closed = true;
    popOverlay(entry);
    overlay.remove();
    restoreFocusTo(opener);
    onClose?.();
  }
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && dismissible) close();
  });
  document.body.appendChild(overlay);
  pushOverlay(entry);
  autoSpinFooter(panel.querySelector(".drawer__foot"), bodyEl, () => closed);
  return { el: overlay, panel, body: bodyEl, close };
}

export function confirmDialog({ title = "Are you sure?", message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  danger = false, icon: iconName } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const instance = modal({
      title,
      size: "sm",
      icon: iconName || (danger ? "warn" : "help"),
      body: h("div", { class: "muted", style: { fontSize: "13.2px", lineHeight: "1.6" } }, message),
      footer: frag(
        button(cancelLabel, { onClick: () => { done(false); instance.close(); } }),
        button(confirmLabel, {
          variant: danger ? "danger" : "primary",
          onClick: () => { done(true); instance.close(); },
        })),
      onClose: () => done(false),
    });
  });
}

export function toast(message, type = "success", title = "") {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = h("div", { class: "toasts" });
    document.body.appendChild(host);
  }
  const iconName = { success: "check", error: "warn", warning: "warn", info: "info" }[type] || "info";
  const duration = type === "error" ? 7000 : 4200;
  const timerBar = h("span", {
    class: "toast__timer",
    style: { animationDuration: `${duration}ms` },
    attrs: { "aria-hidden": "true" },
  });
  const el = h("div", { class: `toast toast--${type}`, attrs: { role: type === "error" ? "alert" : "status" } },
    h("span", { class: "toast__icon" }, icon(iconName)),
    h("div", { class: "grow" },
      title ? h("div", { class: "toast__title" }, title) : null,
      h("div", { class: "toast__msg" }, message)),
    iconButton("x", { size: "sm", variant: "ghost", onClick: () => remove(), title: "Dismiss" }),
    timerBar);
  function remove() {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 180);
  }
  // Hovering pauses the dismissal so a longer message can be read.
  let startedAt = Date.now();
  let remaining = duration;
  let timeout = setTimeout(remove, duration);
  el.addEventListener("mouseenter", () => {
    clearTimeout(timeout);
    remaining = Math.max(600, remaining - (Date.now() - startedAt));
    timerBar.style.animationPlayState = "paused";
  });
  el.addEventListener("mouseleave", () => {
    startedAt = Date.now();
    timeout = setTimeout(remove, remaining);
    timerBar.style.animationPlayState = "running";
  });
  host.appendChild(el);
  // Keep the stack short so toasts never cover the till.
  while (host.children.length > 4) host.firstElementChild.remove();
  return el;
}

export function menu(anchor, items) {
  const existing = document.querySelector(".menu");
  if (existing) existing.remove();
  const el = h("div", { class: "menu", attrs: { role: "menu" } });
  for (const item of items) {
    if (item === "-") {
      el.appendChild(h("div", { class: "menu__sep", attrs: { role: "separator" } }));
      continue;
    }
    if (item.label && item.header) {
      el.appendChild(h("div", { class: "menu__label" }, item.label));
      continue;
    }
    el.appendChild(h("button", {
      class: `menu__item${item.danger ? " menu__item--danger" : ""}`,
      type: "button",
      attrs: { role: "menuitem" },
      onClick: () => {
        el.remove();
        item.onClick?.();
      },
    }, item.icon ? icon(item.icon) : null, h("span", { class: "grow" }, item.label),
      item.shortcut ? h("span", { class: "dim tiny" }, item.shortcut) : null));
  }
  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = rect.right - width;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const dismiss = (e) => {
    if (!el.contains(e.target)) {
      el.remove();
      document.removeEventListener("mousedown", dismiss);
      restoreFocusTo(anchor);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);

  const menuItems = [...el.querySelectorAll(".menu__item")];
  let index = -1;
  const focusAt = (next) => {
    if (!menuItems.length) return;
    index = (next + menuItems.length) % menuItems.length;
    menuItems[index].focus();
  };
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); focusAt(index + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(index - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
    else if (e.key === "End") { e.preventDefault(); focusAt(menuItems.length - 1); }
    else if (e.key === "Escape") {
      e.preventDefault();
      el.remove();
      document.removeEventListener("mousedown", dismiss);
      restoreFocusTo(anchor);
    }
  });
  setTimeout(() => menuItems[0]?.focus(), 20);
  return el;
}

/* ---------- misc ---------------------------------------------------------- */
export function kvList(pairs) {
  const dl = h("dl", { class: "kv" });
  for (const [key, value] of pairs) {
    dl.appendChild(h("dt", {}, key));
    dl.appendChild(h("dd", {}, value));
  }
  return dl;
}

export function moneyText(cents, options) {
  return h("span", { class: "num" }, fmtMoney(cents, options));
}

export function formGrid(children, columns = 2) {
  return h("div", { class: `form-grid${columns === 2 ? " form-grid--2" : ""}` }, children);
}

export function subtleLabel(text) {
  return h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".09em", fontWeight: "650" } }, text);
}

export function alertBox(message, tone = "info", { icon: iconName } = {}) {
  const iconMap = { info: "info", warning: "warn", danger: "warn", success: "check" };
  return h("div", { class: `alert alert--${tone}` }, icon(iconName || iconMap[tone] || "info"),
    h("div", { class: "grow" }, message));
}

/* ---------- search + funding helpers ------------------------------------- */
/* Attach an inline spinner to any search input. The spinner starts as soon as
   the user types and clears when the request it triggered settles (or after a
   short idle for local filtering), so every search box gives feedback. */
const activeSearches = new Set();
let searchListenerBound = false;

function settleSearches() {
  for (const entry of [...activeSearches]) {
    if (!entry.input.isConnected) {
      activeSearches.delete(entry);
      continue;
    }
    entry.finish();
  }
}

export function searchLoader(input, { idleMs = 900, minVisibleMs = 260 } = {}) {
  input.classList.add("search-input");
  let hideTimer = null;
  let startedAt = 0;

  const start = () => {
    startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    clearTimeout(hideTimer);
    input.classList.add("is-searching");
    hideTimer = setTimeout(() => input.classList.remove("is-searching"), idleMs);
  };
  const finish = () => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const wait = Math.max(0, minVisibleMs - (now - startedAt));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => input.classList.remove("is-searching"), wait);
  };

  input.setSearching = (state) => (state ? start() : finish());
  input.addEventListener("input", start);
  activeSearches.add({ input, finish });
  if (!searchListenerBound) {
    searchListenerBound = true;
    window.addEventListener("pos:fetch-settled", settleSearches);
  }
  return input;
}

export const FUNDING_OPTIONS = [
  { value: "profit", label: "Profits from sales" },
  { value: "external", label: "External funds (owner, loan, investor)" },
];

/** Pick the money that paid for new stock: sales profit or money from outside. */
export function fundingPicker({ required = false, label = "Paid with", hint } = {}) {
  const picker = select({
    value: "",
    options: [
      { value: "", label: "Choose where the money came from..." },
      ...FUNDING_OPTIONS,
    ],
  });
  const note = textInput({ placeholder: "e.g. Owner top-up, bank loan, March sales" });
  return {
    picker,
    note,
    fields: [
      field({
        label,
        control: picker,
        required,
        hint: hint || "Cash from sales profit or money brought in from outside the till.",
      }),
      field({ label: "Funding note", control: note, hint: "Optional - who provided it or which month's profit." }),
    ],
    value: () => picker.value,
    noteValue: () => note.value.trim(),
  };
}
