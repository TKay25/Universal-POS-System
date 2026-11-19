/* Tab manager: every opened screen stays mounted so its state survives. */

import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

class TabManager {
  constructor() {
    this.tabs = [];
    this.activeId = null;
    this.bar = null;
    this.host = null;
    this.onChange = null;
  }

  init({ bar, host, onChange }) {
    this.bar = bar;
    this.host = host;
    this.onChange = onChange || null;
  }

  find(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  add({ id, title, icon: iconName, el, instance, path, pinned = false }) {
    const existing = this.find(id);
    if (existing) {
      this.activate(id);
      return existing;
    }

    const slug = String(id).replace(/[^\w-]/g, "-");
    const buttonId = `tab-${slug}`;
    const panelId = `view-${slug}`;
    const button = h("button", {
      class: "tab",
      type: "button",
      title,
      draggable: "true",
      id: buttonId,
      attrs: { role: "tab", "aria-selected": "false", "aria-controls": panelId, tabindex: "-1" },
    });
    const closeBtn = h("span", { class: "tab__close", title: "Close tab", attrs: { "aria-hidden": "true" } }, icon("x"));
    button.appendChild(iconName ? spanIcon(iconName) : null);
    const label = h("span", { class: "tab__title" }, title);
    button.appendChild(label);
    button.appendChild(closeBtn);
    button.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || (e.key === "Backspace" && e.altKey)) {
        e.preventDefault();
        this.close(id);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        this.cycle(e.key === "ArrowRight" ? 1 : -1);
        this.current()?.button.focus();
      }
    });
    button.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.close(id);
      }
    });
    button.addEventListener("click", (e) => {
      if (e.target.closest(".tab__close")) return;
      this.activate(id);
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(id);
    });
    button.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.close(id);
    });

    button.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      button.classList.add("is-dragging");
    });
    button.addEventListener("dragend", () => button.classList.remove("is-dragging"));
    button.addEventListener("dragover", (e) => {
      e.preventDefault();
      button.classList.add("is-drop-target");
    });
    button.addEventListener("dragleave", () => button.classList.remove("is-drop-target"));
    button.addEventListener("drop", (e) => {
      e.preventDefault();
      button.classList.remove("is-drop-target");
      const draggedId = e.dataTransfer.getData("text/plain");
      if (draggedId && draggedId !== id) this.reorder(draggedId, id);
    });

    const view = h("div", {
      class: "view",
      dataset: { tab: id },
      attrs: { role: "tabpanel", id: panelId, "aria-labelledby": buttonId },
    }, el);
    this.host.appendChild(view);
    this.bar.appendChild(button);

    const tab = { id, title, icon: iconName, el: view, inner: el, instance, path, pinned, button, label };
    this.tabs.push(tab);
    this.activate(id);
    return tab;
  }

  reorder(draggedId, targetId) {
    const from = this.tabs.findIndex((tab) => tab.id === draggedId);
    const to = this.tabs.findIndex((tab) => tab.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, moved);
    const buttons = this.tabs.map((tab) => tab.button);
    buttons.forEach((button) => this.bar.appendChild(button));
  }

  activate(id) {
    const tab = this.find(id);
    if (!tab) return null;
    this.activeId = id;
    for (const entry of this.tabs) {
      const active = entry.id === id;
      entry.el.classList.toggle("is-active", active);
      entry.button.classList.toggle("is-active", active);
      entry.button.setAttribute("aria-selected", active ? "true" : "false");
      entry.button.tabIndex = active ? 0 : -1;
    }
    tab.instance?.onActivate?.();
    if (this.onChange) this.onChange(tab);
    return tab;
  }

  setTitle(id, title) {
    const tab = this.find(id);
    if (!tab) return;
    tab.title = title;
    tab.label.textContent = title;
    tab.button.title = title;
    tab.el.setAttribute("aria-label", title);
  }

  close(id, { force = false } = {}) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tab = this.tabs[index];
    if (tab.pinned && !force) return;
    tab.instance?.destroy?.();
    tab.el.remove();
    tab.button.remove();
    this.tabs.splice(index, 1);
    if (this.activeId === id) {
      const next = this.tabs[index] || this.tabs[index - 1] || null;
      if (next) this.activate(next.id);
      else {
        this.activeId = null;
        if (this.onChange) this.onChange(null);
      }
    } else if (this.onChange) {
      this.onChange(this.find(this.activeId));
    }
  }

  closeOthers(id) {
    [...this.tabs].forEach((tab) => {
      if (tab.id !== id && !tab.pinned) this.close(tab.id, { force: true });
    });
    this.activate(id);
  }

  closeAll() {
    [...this.tabs].forEach((tab) => this.close(tab.id, { force: true }));
  }

  current() {
    return this.find(this.activeId);
  }

  cycle(direction = 1) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (index + direction + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }
}

function spanIcon(name) {
  const wrap = document.createElement("span");
  wrap.className = "tab__icon";
  wrap.appendChild(icon(name));
  return wrap;
}

export const tabs = new TabManager();
export { TabManager };
