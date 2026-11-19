/* PWA glue: service-worker registration, install prompt and display mode. */

import { h } from "./dom.js";
import { button, modal } from "./ui.js";

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  // Keep the browser's mini-infobar out of the till and drive the install from
  // the app's own "Install app" entries instead.
  event.preventDefault();
  deferredPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
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

function installSteps() {
  if (isIos()) {
    return ["Tap the Share button in Safari's toolbar.", "Choose Add to Home Screen, then tap Add."];
  }
  if (isAndroid()) {
    return ["Open the browser menu (⋮).", "Choose Install app or Add to Home screen."];
  }
  return [
    "Click the install icon at the right end of the address bar.",
    "Or open the browser menu and choose Install Universal POS.",
  ];
}

function showInstallHelp() {
  const installed = isStandalone();
  let instance = null;
  instance = modal({
    title: "Install Universal POS",
    subtitle: installed ? "Already installed" : "Runs full screen, straight from your home screen or desktop",
    icon: "download",
    size: "sm",
    body: h("div", { class: "col gap-3" },
      h("p", { class: "muted small" }, installed
        ? "This window is already the installed app — launch it from your home screen, app list or desktop."
        : "Installing adds Universal POS to your device with its own icon, a full-screen window and a home for the offline shell."),
      installed ? null : h("ol", { class: "install-steps" }, installSteps().map((step) => h("li", {}, step)))),
    footer: [button("Got it", { variant: "primary", onClick: () => instance.close() })],
  });
}

/** Prompt the browser's install flow, or explain how to install by hand. */
export async function installApp() {
  if (isStandalone()) {
    showInstallHelp();
    return { outcome: "installed" };
  }
  if (!deferredPrompt) {
    showInstallHelp();
    return { outcome: "help" };
  }
  const prompt = deferredPrompt;
  deferredPrompt = null;
  try {
    prompt.prompt();
    const choice = await prompt.userChoice;
    return { outcome: choice?.outcome || "dismissed" };
  } catch {
    showInstallHelp();
    return { outcome: "help" };
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
