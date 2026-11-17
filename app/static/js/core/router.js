/* Hash router that drives the tab manager. */

import { tabs } from "./tabs.js";
import { routeProgress } from "./loading.js";

export function createRouter({ routes, views, canOpen, onDenied }) {
  let started = false;

  const hashPath = () => {
    const raw = window.location.hash.replace(/^#/, "");
    return raw || "/dashboard";
  };

  const match = (path) => {
    for (const route of routes) {
      const found = path.match(route.match);
      if (found) return { route, params: found.groups || {} };
    }
    return null;
  };

  function syncUrl(path) {
    if (window.location.hash !== `#${path}`) {
      window.history.pushState({ path }, "", `#${path}`);
    }
  }

  async function go(path, { silent = false } = {}) {
    const clean = path.startsWith("/") ? path : `/${path}`;
    const found = match(clean);
    if (!found) {
      if (!silent) onDenied?.("That screen does not exist.", clean);
      return false;
    }
    const { route, params } = found;
    if (canOpen && !canOpen(route)) {
      if (!silent) onDenied?.(route.deniedMessage || "You do not have access to that screen.", clean);
      return false;
    }

    const tabId = typeof route.tab === "function" ? route.tab(params) : route.tab;
    let tab = tabs.find(tabId);

    if (tab) {
      tab.path = clean;
      tab.instance?.onRoute?.(params, clean);
      tabs.activate(tabId);
      syncUrl(clean);
      return true;
    }

    const factory = views[route.view];
    if (!factory) {
      onDenied?.("That screen is not available.", clean);
      return false;
    }

    let instance;
    routeProgress.start();
    try {
      instance = await factory({ params, tabId, path: clean, navigate: go });
    } catch (error) {
      console.error("Failed to open view", route.view, error);
      onDenied?.(error?.message || "Could not open that screen.", clean);
      return false;
    } finally {
      routeProgress.done();
    }

    tab = tabs.add({
      id: tabId,
      title: route.title(params) || "Untitled",
      icon: route.icon || "dot",
      el: instance.el,
      instance,
      path: clean,
      pinned: Boolean(route.pinned),
    });
    instance.onRoute?.(params, clean);
    syncUrl(clean);
    return true;
  }

  function start() {
    if (started) return;
    started = true;
    window.addEventListener("popstate", () => {
      go(hashPath(), { silent: true });
    });
    window.addEventListener("hashchange", () => {
      const path = hashPath();
      const current = tabs.current();
      if (!current || current.path !== path) go(path, { silent: true });
    });
    go(hashPath(), { silent: true });
  }

  return { go, start, currentPath: hashPath };
}
