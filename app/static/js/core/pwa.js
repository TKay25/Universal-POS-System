/* PWA glue: service-worker registration, install prompt and display mode. */

import { h } from "./dom.js";
import { button, modal, toast } from "./ui.js";

let deferredPrompt = window.__posInstallPrompt || null;

window.addEventListener("beforeinstallprompt", (event) => {
  // Keep the browser's mini-infobar out of the till and drive the install from
  // the app's own "Install app" entries instead.
  event.preventDefault();
  deferredPrompt = event;
  if (window.__posInstallPrompt !== event) {
    window.__posInstallPrompt = event;
    window.dispatchEvent(new Event("pos:install-available"));
  }
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  window.__posInstallPrompt = null;
});

export function isStandalone() {
  try {
    const modes = ["standalone", "fullscreen", "minimal-ui"];
    if (modes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)) return true;
  } catch { /* no matchMedia: fall back to the iOS flag below */ }
  return window.navigator.standalone === true;
}

function isIos() {
  const ua = window.navigator.userAgent || "";
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS reports itself as a Mac; touch points give it away.
  return window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
}

function isAndroid() {
  return /android/i.test(window.navigator.userAgent || "");
}

/**
 * True when a one-click install is genuinely possible: the browser handed us its
 * install prompt, or we are on iOS where the share sheet is the only route.
 */
export function canInstall() {
  if (isStandalone()) return false;
  if (deferredPrompt || window.__posInstallPrompt) return true;
  return isIos();
}

function showIosInstallHelp() {
  let instance = null;
  instance = modal({
    title: "Add to Home Screen",
    subtitle: "iPhone and iPad install through Safari's share sheet",
    icon: "download",
    size: "sm",
    body: h("div", { class: "col gap-3" },
      h("div", { class: "install-single" },
        icon("share"),
        h("span", {}, "Tap ", h("strong", {}, "Share"), ", then ", h("strong", {}, "Add to Home Screen"), ".")),
      h("p", { class: "tiny dim" }, "It opens full screen with its own icon, like any other app.")),
    footer: [button("Got it", { variant: "primary", onClick: () => instance.close() })],
  });
}

/** One click when the browser allows it; the share-sheet line on iOS. */
export async function installApp() {
  if (isStandalone()) {
    toast("Universal POS is already installed on this device.", "info");
    return { outcome: "installed" };
  }
  const prompt = deferredPrompt || window.__posInstallPrompt;
  if (!prompt) {
    if (isIos()) {
      showIosInstallHelp();
      return { outcome: "help" };
    }
    toast("This browser has not offered the install yet. Try again in a moment.", "info");
    return { outcome: "unavailable" };
  }
  deferredPrompt = null;
  window.__posInstallPrompt = null;
  try {
    prompt.prompt();
    const choice = await prompt.userChoice;
    return { outcome: choice?.outcome || "dismissed" };
  } catch {
    toast("This browser has not offered the install yet. Try again in a moment.", "info");
    return { outcome: "unavailable" };
  }
}

/** Register the worker once the shell is up; failures must never break the app. */
export function initPwa() {
  if (!("serviceWorker" in window.navigator)) return;
  if (!window.isSecureContext) return;
  const register = () => {
    window.navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
