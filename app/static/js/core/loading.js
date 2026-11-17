/* Shared progress + busy feedback: route bar, busy overlay and button spinners. */

import { h } from "./dom.js";

let bar = null;
let barTimer = null;

function ensureBar() {
  if (bar && bar.isConnected) return bar;
  bar = h("div", { class: "route-progress", role: "progressbar", "aria-hidden": "true" },
    h("span", { class: "route-progress__bar" }));
  document.body.appendChild(bar);
  return bar;
}

export const routeProgress = {
  start() {
    const element = ensureBar();
    const fill = element.firstElementChild;
    element.classList.add("is-active");
    fill.style.transition = "none";
    fill.style.width = "8%";
    requestAnimationFrame(() => {
      fill.style.transition = "width 1.6s cubic-bezier(.2,.8,.2,1)";
      fill.style.width = "72%";
    });
    clearTimeout(barTimer);
    // Never leave the bar stuck on if a view forgets to finish.
    barTimer = setTimeout(() => routeProgress.done(), 12000);
  },
  done() {
    clearTimeout(barTimer);
    if (!bar) return;
    const fill = bar.firstElementChild;
    fill.style.transition = "width 180ms ease";
    fill.style.width = "100%";
    setTimeout(() => {
      bar.classList.remove("is-active");
      fill.style.transition = "none";
      fill.style.width = "0";
    }, 190);
  },
};

export function busyOverlay(message = "Working…") {
  const overlay = h("div", { class: "busy-overlay", role: "status", "aria-live": "polite" },
    h("div", { class: "busy-overlay__card" },
      h("span", { class: "spinner" }),
      h("span", { class: "busy-overlay__label" }, message)));
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("is-visible"));
  return {
    update(text) {
      const label = overlay.querySelector(".busy-overlay__label");
      if (label) label.textContent = text;
    },
    close() {
      overlay.classList.remove("is-visible");
      setTimeout(() => overlay.remove(), 180);
    },
  };
}

/* Shows a spinner inside the button and blocks double submits. */
export async function withButtonSpinner(element, task) {
  if (!element || element.disabled) return undefined;
  const started = Date.now();
  if (typeof element.setLoading === "function") element.setLoading(true);
  else {
    element.classList.add("is-loading");
    element.disabled = true;
  }
  try {
    return await task();
  } finally {
    const elapsed = Date.now() - started;
    const wait = Math.max(0, 260 - elapsed);
    setTimeout(() => {
      if (typeof element.setLoading === "function") element.setLoading(false);
      else {
        element.classList.remove("is-loading");
        element.disabled = false;
      }
    }, wait);
  }
}

/* Convenience: run a navigation-triggering action and show the bar meanwhile. */
export async function withProgress(task) {
  routeProgress.start();
  try {
    return await task();
  } finally {
    routeProgress.done();
  }
}
