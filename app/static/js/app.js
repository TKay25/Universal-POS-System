/* Application shell: session bootstrap, sidebar, topbar, tabs, palette. */

import { h, clear, mount, $ } from "./core/dom.js";
import { icon } from "./core/icons.js";
import { money, dateTime, initials, timeZone, isoDay } from "./core/fmt.js";
import {
  store, applyBranding, getSession, isAuthed, isDeveloper, impersonating, moduleOn,
  hasPerm, hasAny, companyName, currentUser, currentCompany, preferences, wordmark,
} from "./core/store.js";
import { toggleThemePreference, savePreferences } from "./core/prefs.js";
import { api, get, post } from "./core/http.js";
import { tabs } from "./core/tabs.js";
import { createRouter } from "./core/router.js";
import {
  ALL_BRANCHES, branchLocations, branchQuery, branchScope, isAllBranches, setBranchScope,
} from "./core/branch.js";
import { initPwa, installApp, isStandalone, canInstall } from "./core/pwa.js";
import { mountOfflineUi, refreshOfflineBar, promptPush } from "./core/offlineUi.js";
import { outboxCount } from "./core/offline.js";
import {
  button, iconButton, avatar, modal, drawer, toast, menu, field, textInput, switchRow,
  alertBox, sectionCard, badge,
} from "./core/ui.js";

import loginView from "./views/login.js";
import dashboardView from "./views/dashboard.js";
import posView from "./views/pos.js";
import salesView from "./views/sales.js";
import inventoryView from "./views/inventory.js";
import barcodesView from "./views/barcodes.js";
import customersView from "./views/customers.js";
import departmentsView from "./views/departments.js";
import laybysView from "./views/laybys.js";
import reportsView from "./views/reports.js";
import shiftsView from "./views/shifts.js";
import settingsView from "./views/settings.js";
import developerView from "./views/developer.js";
import workspaceView from "./views/workspace.js";
import activityView from "./views/activity.js";
import mobileAppView from "./views/mobileApp.js";
import passwordGate, { openPasswordDialog } from "./views/password.js";

const views = {
  dashboard: dashboardView,
  pos: posView,
  sales: salesView,
  inventory: inventoryView,
  barcodes: barcodesView,
  customers: customersView,
  departments: departmentsView,
  laybys: laybysView,
  reports: reportsView,
  activity: activityView,
  shifts: shiftsView,
  settings: settingsView,
  developer: developerView,
  workspace: workspaceView,
};

const routes = [
  {
    match: /^\/dashboard\/?$/,
    tab: "dashboard",
    view: "dashboard",
    title: () => "Dashboard",
    icon: "home",
  },
  {
    match: /^\/pos\/?$/,
    tab: "pos",
    view: "pos",
    title: () => "Point of sale",
    icon: "cart",
    module: "pos",
    perm: "pos.sell",
    deniedMessage: "You do not have permission to sell at the till.",
  },
  {
    match: /^\/sales\/?$/,
    tab: "sales",
    view: "sales",
    title: () => "Sales",
    icon: "receipt",
    perm: "pos.sell",
  },
  {
    match: /^\/departments\/?$/,
    tab: "departments",
    view: "departments",
    title: () => "Departments",
    icon: "layers",
    module: "departments",
    perm: "products.manage",
  },
  {
    match: /^\/laybys\/?$/,
    tab: "laybys",
    view: "laybys",
    title: () => "Lay-bys",
    icon: "wallet",
    module: "layby",
    perm: "pos.sell",
  },
  {
    match: /^\/inventory\/?$/,
    tab: "inventory",
    view: "inventory",
    title: () => "Inventory",
    icon: "layers",
    module: "inventory",
    perm: "inventory.manage",
    allowedAlso: ["products.manage"],
  },
  {
    match: /^\/barcodes\/?$/,
    tab: "barcodes",
    view: "barcodes",
    title: () => "Barcode studio",
    icon: "barcode",
    module: "barcode",
    perm: "products.manage",
  },
  {
    match: /^\/customers\/?$/,
    tab: "customers",
    view: "customers",
    title: () => "Customers",
    icon: "users",
    module: "customers",
    perm: "customers.manage",
  },
  {
    match: /^\/reports\/?$/,
    tab: "reports",
    view: "reports",
    title: () => "Reports",
    icon: "chart",
    module: "reports",
    perm: "reports.view",
  },
  {
    match: /^\/shifts\/?$/,
    tab: "shifts",
    view: "shifts",
    title: () => "Cash drawer",
    icon: "clock",
    module: "shifts",
    perm: "shifts.manage",
  },
  {
    match: /^\/activity\/?$/,
    tab: "activity",
    view: "activity",
    title: () => "Activity log",
    icon: "list",
    module: "audit_log",
    perm: "audit.view",
    deniedMessage: "Only administrators can read the activity log.",
  },
  {
    match: /^\/settings(?:\/(?<section>[a-z0-9-]+))?\/?$/,
    tab: "settings",
    view: "settings",
    title: () => "Workspace settings",
    icon: "settings",
    deniedMessage: "Sign in to a workspace to open settings.",
  },
  {
    match: /^\/developer(?:\/(?<section>[a-z0-9-]+))?\/?$/,
    tab: "developer",
    view: "developer",
    title: () => "Developer console",
    icon: "shield",
    developerOnly: true,
    deniedMessage: "The developer console is restricted to platform staff.",
  },
  {
    match: /^\/workspaces\/(?<id>\d+)\/?$/,
    tab: (params) => `workspace:${params.id}`,
    view: "workspace",
    title: () => "Workspace",
    icon: "sparkles",
    module: "custom_workspaces",
  },
];

let router = null;
let shellEl = null;
let shellMode = "";
let mobileInstance = null;
let sidebarDrawer = null;
let viewportNarrow = null;
let appStartTime = Date.now();

/* ------------------------------------------------------------------------- */
/* Phone shell                                                                */
/* ------------------------------------------------------------------------- */
const MOBILE_QUERY = "(max-width: 820px)";
const FULL_APP_KEY = "pos:full-app";
const SIDEBAR_KEY = "pos:sidebar";

function sidebarMode() {
  const saved = preferences().sidebar;
  if (saved === "expanded" || saved === "collapsed") return saved;
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

function applySidebarMode(mode) {
  document.documentElement.dataset.sidebar = mode;
  try {
    window.localStorage.setItem(SIDEBAR_KEY, mode);
  } catch { /* private mode: the choice just does not persist */ }
  document.querySelectorAll(".topbar__sidebar-toggle").forEach((btn) => {
    btn.replaceChildren(icon(mode === "collapsed" ? "chevronRight" : "chevronLeft"));
    btn.title = mode === "collapsed" ? "Expand the sidebar" : "Collapse the sidebar";
  });
}

function toggleSidebarMode() {
  const next = document.documentElement.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
  applySidebarMode(next);
  savePreferences({ sidebar: next }).catch(() => { /* offline: the browser keeps the choice */ });
}

function themeIconName() {
  return document.documentElement.dataset.theme === "dark" ? "sun" : "moon";
}

function themeActionLabel() {
  return document.documentElement.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
}

async function flipTheme(buttonEl) {
  try {
    const next = await toggleThemePreference();
    if (buttonEl) {
      buttonEl.replaceChildren(icon(next === "dark" ? "sun" : "moon"));
      buttonEl.title = next === "dark" ? "Switch to light theme" : "Switch to dark theme";
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function fullAppPreferred() {
  try {
    return window.localStorage.getItem(FULL_APP_KEY) === "1";
  } catch {
    return false;
  }
}

function setFullAppPreferred(value) {
  try {
    if (value) window.localStorage.setItem(FULL_APP_KEY, "1");
    else window.localStorage.removeItem(FULL_APP_KEY);
  } catch { /* private mode: fall through, the shell simply re-renders */ }
}

function isMobileShell() {
  if (fullAppPreferred()) return false;
  // The platform console has no tenant context, so it always uses the full app.
  if (!currentCompany()) return false;
  return narrowViewport();
}

function narrowViewport() {
  try {
    return Boolean(window.matchMedia?.(MOBILE_QUERY).matches);
  } catch {
    return false;
  }
}

function destroyMobile() {
  if (mobileInstance?.destroy) {
    try { mobileInstance.destroy(); } catch (error) { console.error("Mobile view cleanup failed", error); }
  }
  mobileInstance = null;
}

function renderMobileShell() {
  const root = document.getElementById("root");
  tabs.closeAll();
  router = null;
  destroyMobile();
  clear(root);
  mobileInstance = mobileAppView({
    onOpenFullApp: () => { setFullAppPreferred(true); renderShell(); },
    onOpenTill: () => { setFullAppPreferred(true); renderShell(); router?.go("/pos"); },
    onSignOut: signOut,
  });
  shellEl = mobileInstance.el;
  shellMode = "mobile";
  document.documentElement.dataset.shell = "phone";
  root.appendChild(shellEl);
}

/* ------------------------------------------------------------------------- */
/* Header clock                                                               */
/* ------------------------------------------------------------------------- */
let clockZone = "";
let clockTimeFmt = null;
let clockDateFmt = null;
let clockTimer = null;

function tickHeaderClock() {
  if (timeZone() !== clockZone) {
    clockZone = timeZone();
    clockTimeFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: clockZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    clockDateFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: clockZone, weekday: "short", day: "2-digit", month: "short", year: "numeric",
    });
  }
  const now = new Date();
  const time = clockTimeFmt.format(now);
  const date = clockDateFmt.format(now);
  document.querySelectorAll(".topbar__clock").forEach((node) => {
    const timeEl = node.querySelector(".topbar__clock-time");
    const dateEl = node.querySelector(".topbar__clock-date");
    if (timeEl) timeEl.textContent = time;
    if (dateEl) dateEl.textContent = date;
  });
}

function startHeaderClock() {
  tickHeaderClock();
  if (!clockTimer) clockTimer = setInterval(tickHeaderClock, 1000);
}

/* ------------------------------------------------------------------------- */
/* Boot                                                                       */
/* ------------------------------------------------------------------------- */
async function boot() {
  const root = document.getElementById("root");
  mountOfflineUi();
  try {
    const session = await get("/auth/session", undefined, { retry: false });
    store.set({ session: session.authenticated ? session : null, csrf: session.csrf_token, ready: true });
  } catch (error) {
    renderBootError(error);
    return;
  }

  if (isAuthed()) {
    // An installed app always opens on the login screen for the new launch; a
    // session that carries on inside the same window stays signed in.
    if (isStandalone() && !launchAlreadyHandled()) {
      markLaunchHandled();
      renderAuth();
      return;
    }
    // Signed-in users always land on a real screen, never on the sign-in hash.
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || hash === "/login" || hash === "/register") {
      const canSell = currentCompany() && moduleOn("pos") && hasPerm("pos.sell");
      const target = canSell ? "/pos" : "/dashboard";
      window.history.replaceState({ path: target }, "", `#${target}`);
    } else if (hash.startsWith("/products")) {
      // The Products tab folded into Inventory; keep old links working.
      window.history.replaceState({ path: "/inventory" }, "", "#/inventory");
    }
    renderShell();
  } else {
    if (isStandalone()) markLaunchHandled();
    renderAuth();
  }
}

const LAUNCH_KEY = "pos:launch";

function launchAlreadyHandled() {
  try {
    return window.sessionStorage.getItem(LAUNCH_KEY) === "1";
  } catch {
    return false;
  }
}

function markLaunchHandled() {
  try {
    window.sessionStorage.setItem(LAUNCH_KEY, "1");
  } catch { /* private mode: the installed app simply asks every time */ }
}

/* The installed app opens from its cache, so the first thing a user sees
   offline is this retry instead of the browser's error page. */
function renderBootError(error) {
  const root = document.getElementById("root");
  mount(root, h("div", { class: "auth" }, h("div", { class: "auth__panel" },
    h("div", { class: "col gap-3" },
      alertBox(navigator.onLine
        ? error.message || "Could not reach the server."
        : "You are offline. Universal POS reconnects as soon as your device is back online.", "danger"),
      button("Try again", { variant: "primary", block: true, icon: "refresh", onClick: () => boot() })))));
  window.addEventListener("online", () => boot(), { once: true });
}

function renderAuth(message = "") {
  const root = document.getElementById("root");
  destroyMobile();
  shellEl = null;
  shellMode = "";
  // Drop any tenant branding so the sign-in screen uses the product palette.
  applyBranding();
  clear(root);
  root.appendChild(loginView({
    initialError: message,
    onAuthed: () => {
      store.set({ ready: true });
      const canSell = currentCompany() && moduleOn("pos") && hasPerm("pos.sell");
      const target = canSell ? "/pos" : "/dashboard";
      window.history.replaceState({ path: target }, "", `#${target}`);
      renderShell();
    },
  }));
}

/* ------------------------------------------------------------------------- */
/* Shell                                                                      */
/* ------------------------------------------------------------------------- */
function isAllowed(route) {
  if (route.developerOnly) return isDeveloper();
  if (isDeveloper() && !impersonating()) return false;
  if (!currentCompany()) return false;
  if (route.module && !moduleOn(route.module)) return false;
  if (route.perm && !hasPerm(route.perm)) {
    if (!route.allowedAlso || !hasAny(...route.allowedAlso)) return false;
  }
  return true;
}

function navModel() {
  const groups = [];
  if (isDeveloper() && !impersonating()) {
    return [
      { label: "Platform", items: [{ label: "Developer console", path: "/developer", icon: "shield" }] },
    ];
  }
  groups.push({
    label: "",
    items: [
      { label: "Dashboard", path: "/dashboard", icon: "home" },
      ...(moduleOn("pos") && hasPerm("pos.sell")
        ? [{ label: "Point of sale", path: "/pos", icon: "cart", badge: "POS" }]
        : []),
      ...(hasPerm("pos.sell") ? [{ label: "Sales", path: "/sales", icon: "receipt" }] : []),
    ],
  });
  const catalog = [];
  if (moduleOn("departments") && hasPerm("products.manage")) {
    catalog.push({ label: "Departments", path: "/departments", icon: "layers" });
  }
  if (moduleOn("inventory") && hasAny("inventory.manage", "products.manage")) {
    catalog.push({ label: "Inventory", path: "/inventory", icon: "layers" });
  }
  if (moduleOn("barcode") && hasPerm("products.manage")) {
    catalog.push({ label: "Barcode studio", path: "/barcodes", icon: "barcode" });
  }
  if (moduleOn("customers") && hasPerm("customers.manage")) {
    catalog.push({ label: "Customers", path: "/customers", icon: "users" });
  }
  if (catalog.length) groups.push({ label: "Catalog", items: catalog });

  if (moduleOn("layby") && hasPerm("pos.sell")) {
    groups.push({ label: "Selling", items: [
      { label: "Lay-bys", path: "/laybys", icon: "wallet" },
    ] });
  }

  const ops = [];
  if (moduleOn("reports") && hasPerm("reports.view")) ops.push({ label: "Reports", path: "/reports", icon: "chart" });
  if (moduleOn("shifts") && hasPerm("shifts.manage")) ops.push({ label: "Cash drawer", path: "/shifts", icon: "clock" });
  if (moduleOn("audit_log") && hasPerm("audit.view")) ops.push({ label: "Activity log", path: "/activity", icon: "list" });
  if (ops.length) groups.push({ label: "Insights", items: ops });

  const admin = [];
  if (hasAny("settings.manage", "users.manage", "audit.view")) {
    admin.push({ label: "Settings", path: "/settings", icon: "settings" });
  }
  if (isDeveloper()) admin.push({ label: "Developer console", path: "/developer", icon: "shield" });
  if (admin.length) groups.push({ label: "Platform", items: admin });
  return groups;
}

function renderShell() {
  applyBranding();
  viewportNarrow = narrowViewport();
  refreshOfflineBar();
  // A teammate added with a temporary password gets the gate instead of a shell,
  // on phones and desktops alike, until they have chosen their own.
  if (currentUser()?.must_change_password) {
    renderFirstRun();
    return;
  }
  applySidebarMode(sidebarMode());
  startHeaderClock();
  if (isMobileShell()) {
    renderMobileShell();
    return;
  }
  destroyMobile();
  shellMode = "desktop";
  document.documentElement.dataset.shell = "full";
  tabs.closeAll();
  const root = document.getElementById("root");
  clear(root);

  const sidebar = h("aside", { class: "sidebar" });
  const topbar = h("header", { class: "topbar" });
  const tabbar = h("div", { class: "tabbar", attrs: { role: "tablist", "aria-label": "Open views" } });
  const viewsHost = h("div", { class: "views", attrs: { id: "main-content", role: "main", tabindex: "-1" } });
  const main = h("div", { class: "main" }, topbar, tabbar, viewsHost);
  const skipLink = h("button", {
    class: "skip-link",
    type: "button",
    onClick: () => viewsHost.focus(),
  }, "Skip to content");
  shellEl = h("div", { class: "app" }, skipLink, sidebar, main);
  root.appendChild(shellEl);

  renderSidebar(sidebar);
  renderTopbar(topbar);
  tickHeaderClock();
  sidebarDrawer = wireSidebarDrawer(sidebar);

  if (isDeveloper() && !currentCompany()) {
    const target = "#/developer";
    if (!window.location.hash.startsWith("#/developer")) {
      window.history.replaceState({ path: "/developer" }, "", target);
    }
  }

  tabs.init({
    bar: tabbar,
    host: viewsHost,
    onChange: (tab) => {
      sidebarDrawer?.close();
      updateTopbarTitle(topbar, tab);
      markActiveNav(sidebar, tab);
      if (tab) {
        const target = `#${tab.path}`;
        if (window.location.hash !== target) window.history.replaceState({ path: tab.path }, "", target);
      }
    },
  });

  router = createRouter({
    routes,
    views,
    canOpen: isAllowed,
    onDenied: (message) => toast(message, "warning", "Not available"),
  });
  router.start();
  if (!window.location.hash.startsWith("#/pos")) {
    setTimeout(prefetchCoreReports, 800);
  }
}

/* Invited teammates sign in with a temporary password; this replaces the whole
   shell (phone or desktop) until they have chosen their own. */
function renderFirstRun() {
  tabs.closeAll();
  destroyMobile();
  router = null;
  shellMode = "gate";
  document.documentElement.dataset.shell = "auth";
  const root = document.getElementById("root");
  clear(root);
  shellEl = passwordGate({
    user: currentUser(),
    onDone: () => {
      const session = getSession();
      store.set({ session: { ...session, user: { ...session.user, must_change_password: false } } });
      if (!window.location.hash.startsWith("#/")) {
        const canSell = currentCompany() && moduleOn("pos") && hasPerm("pos.sell");
        const target = canSell ? "/pos" : "/dashboard";
        window.history.replaceState({ path: target }, "", `#${target}`);
      }
      renderShell();
      toast("Password saved. Welcome to Universal POS.", "success");
    },
    onSignOut: signOut,
  });
  root.appendChild(shellEl);
}

function renderSidebar(sidebar) {
  clear(sidebar);
  const company = currentCompany();
  const branding = company?.settings?.branding || {};
  const logoText = wordmark(company) || "Universal POS";

  const brand = h("div", { class: "brand" },
    h("div", { class: "brand__mark" },
      branding.logo_data_url
        ? h("img", { src: branding.logo_data_url, alt: logoText })
        : company ? initials(logoText) : icon("logo")),
    h("div", { class: "brand__text" },
      h("div", { class: "brand__name truncate" }, logoText || "Universal POS"),
      h("div", { class: "brand__sub" }, isDeveloper() && !impersonating() ? "Platform console" : company?.plan ? `${company.plan} plan` : "Workspace")));
  sidebar.appendChild(brand);

  const nav = h("nav", { class: "nav", attrs: { "aria-label": "Primary" } });
  const groups = navModel();
  for (const group of groups) {
    if (group.label) nav.appendChild(h("div", { class: "nav__label" }, group.label));
    for (const item of group.items) {
      const btn = h("button", {
        class: "nav__item",
        type: "button",
        dataset: { path: item.path },
        onClick: () => router?.go(item.path),
        title: item.label,
      }, icon(item.icon), h("span", {}, item.label),
      item.badge ? h("span", { class: "nav__badge", style: { background: "color-mix(in srgb, var(--primary) 90%, black)" } }, item.badge) : null);
      nav.appendChild(btn);
    }
  }

  if (moduleOn("custom_workspaces")) {
    const holder = h("div", { class: "nav__label" }, "Your workspaces");
    nav.appendChild(holder);
    const list = h("div", { class: "list", style: { display: "flex", flexDirection: "column", gap: "2px" } });
    nav.appendChild(list);
    get("/workspaces").then(({ items }) => {
      if (!items.length) {
        holder.style.display = "none";
        return;
      }
      for (const workspace of items) {
        list.appendChild(h("button", {
          class: "nav__item",
          type: "button",
          dataset: { path: `/workspaces/${workspace.id}` },
          onClick: () => router?.go(`/workspaces/${workspace.id}`),
          title: workspace.name,
        }, icon(workspace.icon || "sparkles"), h("span", {}, workspace.name)));
      }
    }).catch(() => {});
  }

  sidebar.appendChild(nav);

  const user = currentUser();
  const footer = h("div", { class: "sidebar__footer" });
  const userButton = h("button", { class: "sidebar__user", type: "button" },
    avatar(user.full_name, user.avatar_color, "sm"),
    h("div", { class: "user-meta grow", style: { minWidth: 0 } },
      h("div", { class: "truncate", style: { fontSize: "12.6px", fontWeight: "600" } }, user.full_name),
      h("div", { class: "dim tiny truncate" }, user.role || "Developer")),
    icon("more"));
  userButton.addEventListener("click", () => openUserMenu(userButton));
  footer.appendChild(userButton);
  sidebar.appendChild(footer);
}

/* The full app on a phone-sized window gets an off-canvas sidebar instead of a
   permanently hidden one, otherwise there would be no way to navigate. */
function wireSidebarDrawer(sidebar) {
  let backdrop = null;
  const close = () => {
    sidebar.classList.remove("is-open");
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
  };
  return {
    close,
    toggle() {
      if (sidebar.classList.contains("is-open")) {
        close();
        return;
      }
      sidebar.classList.add("is-open");
      backdrop = h("div", { class: "sidebar-backdrop", onClick: close });
      shellEl?.appendChild(backdrop);
    },
  };
}

function branchPicker() {
  const company = currentCompany();
  const locations = branchLocations();
  if (!company || locations.length < 2) return null;
  const scope = branchScope();
  const onPos = window.location.hash.startsWith("#/pos");
  const buttonEl = h("button", {
    class: `btn btn--sm topbar__branch${scope.all ? " is-all" : ""}`,
    type: "button",
    title: scope.all ? "All branches — read-only aggregate view" : `Selling and viewing ${scope.label}`,
  }, icon("map"), h("span", {}, scope.label),
  scope.all ? h("span", { class: "topbar__branch-tag" }, "read-only") : null,
  icon("chevronDown"));

  buttonEl.addEventListener("click", () => {
    const items = [
      ...(onPos ? [] : [{
        label: "All branches",
        icon: "layers",
        onClick: () => switchBranch(ALL_BRANCHES),
      }]),
      "-",
      ...locations.map((row) => ({
        label: `${row.name}${row.is_default ? " (default)" : ""}`,
        icon: "map",
        onClick: () => switchBranch(row.id),
      })),
    ];
    if (hasPerm("settings.manage")) {
      items.push("-", { label: "Manage branches", icon: "settings", onClick: () => router?.go("/settings/locations") });
    }
    menu(buttonEl, items);
  });
  return buttonEl;
}

function switchBranch(value) {
  const scope = setBranchScope(value);
  renderTopbar(document.querySelector(".topbar"));
  router?.refresh();
  toast(scope.all ? "Showing all branches (read-only)." : `Now working in ${scope.label}.`, "info");
}

function renderTopbar(topbar) {
  clear(topbar);
  const company = currentCompany();
  const narrow = narrowViewport();

  if (narrow) {
    topbar.appendChild(iconButton("menu", {
      title: "Menu",
      onClick: () => sidebarDrawer?.toggle(),
    }));
  }

  const title = h("div", { class: "topbar__title" }, "Dashboard");
  const crumbs = h("div", { class: "topbar__crumbs" },
    icon("building"),
    h("span", { class: "topbar__company" }, company?.name || "Universal POS"));
  topbar.appendChild(h("div", { class: "topbar__lead" }, title, crumbs));
  const picker = branchPicker();
  if (picker) topbar.appendChild(picker);
  topbar.appendChild(h("div", { class: "topbar__spacer" }));
  topbar.appendChild(h("div", {
    class: "topbar__clock",
    title: `${timeZone()} time`,
  }, h("span", { class: "topbar__clock-time" }, ""), h("span", { class: "topbar__clock-date" }, "")));

  const search = h("button", { class: "searchbox", type: "button", onClick: openPalette, title: "Search (Ctrl+K)" },
    icon("search"), h("span", {}, "Search or jump to…"), h("kbd", {}, navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"));
  topbar.appendChild(search);

  if (isDeveloper()) topbar.appendChild(companySwitcher());

  const announcements = getSession()?.announcements || [];
  if (announcements.length) {
    const bell = iconButton("bell", { title: `${announcements.length} announcements`, onClick: () => openAnnouncements(announcements) });
    bell.appendChild(h("span", { class: "iconbtn__dot" }));
    topbar.appendChild(bell);
  }

  if (!isStandalone() && canInstall()) {
    const installBtn = button("Install", {
      variant: "soft",
      size: "sm",
      icon: "download",
      title: "Install Universal POS",
      onClick: () => installApp(),
    });
    installBtn.classList.add("topbar__install");
    topbar.appendChild(installBtn);
  }

  const themeBtn = iconButton(themeIconName(), {
    title: themeActionLabel(),
    onClick: () => flipTheme(themeBtn),
  });
  topbar.appendChild(themeBtn);

  if (hasPerm("pos.sell") && currentCompany() && !isAllBranches()) {
    topbar.appendChild(button("New sale", {
      variant: "primary",
      size: "sm",
      icon: "plus",
      title: "Start a new sale",
      onClick: () => router?.go("/pos"),
    }));
  }
  if (!narrow) {
    const collapse = iconButton(sidebarMode() === "collapsed" ? "chevronRight" : "chevronLeft", {
      title: sidebarMode() === "collapsed" ? "Expand the sidebar" : "Collapse the sidebar",
      onClick: toggleSidebarMode,
    });
    collapse.classList.add("topbar__sidebar-toggle");
    topbar.appendChild(collapse);
  }
  const user = currentUser();
  topbar.appendChild(iconButton("more", { title: "Account", onClick: (e) => openUserMenu(e.currentTarget) }));
}

function companySwitcher() {
  const company = currentCompany();
  const label = impersonating() && company ? company.name : "Platform";
  const buttonEl = h("button", { class: "btn btn--sm", type: "button", title: "Switch workspace" },
    icon("building"), h("span", {}, label), icon("chevronDown"));
  buttonEl.addEventListener("click", async () => {
    const data = await get("/developer/companies", { per_page: 100 });
    const items = [
      { label: "Platform console", icon: "shield", onClick: () => leaveToConsole() },
      "-",
      { header: true, label: "Companies" },
      ...data.items.map((row) => ({
        label: row.name,
        icon: "building",
        onClick: () => enterCompany(row.id),
      })),
    ];
    menu(buttonEl, items);
  });
  return buttonEl;
}

async function enterCompany(companyId) {
  try {
    const session = await post(`/auth/enter-company/${companyId}`);
    store.set({ session, csrf: session.csrf_token });
    applyBranding();
    renderShell();
    toast(`You are now working inside ${session.company?.name}.`, "info", "Workspace switched");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function leaveToConsole() {
  try {
    const session = await post("/auth/leave-company");
    store.set({ session, csrf: session.csrf_token });
    applyBranding();
    renderShell();
    router?.go("/developer");
    toast("Back on the platform console.", "info");
  } catch (error) {
    toast(error.message, "error");
  }
}

function updateTopbarTitle(topbar, tab) {
  const title = topbar.querySelector(".topbar__title");
  const page = topbar.querySelector(".topbar__page");
  if (title) title.textContent = tab?.title || "Dashboard";
  if (page) page.textContent = tab?.title || "Dashboard";
}

function markActiveNav(sidebar, tab) {
  const path = tab?.path || "/dashboard";
  sidebar.querySelectorAll(".nav__item").forEach((item) => {
    const target = item.dataset.path || "";
    const active = target === path || (target !== "/dashboard" && path.startsWith(`${target}/`));
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

/* ------------------------------------------------------------------------- */
/* User menu                                                                  */
/* ------------------------------------------------------------------------- */
function openUserMenu(anchor) {
  const user = currentUser();
  const items = [
    { label: user.full_name, header: true },
    { label: "Your preferences", icon: "sliders", onClick: () => router?.go("/settings/preferences") },
    { label: "Change password", icon: "key", onClick: () => openPasswordDialog() },
    { label: themeActionLabel(), icon: themeIconName(), onClick: () => flipTheme() },
  ];
  if (isDeveloper()) {
    items.push("-");
    items.push({ label: impersonating() ? "Leave workspace" : "Developer console", icon: "shield",
      onClick: () => (impersonating() ? leaveToConsole() : router?.go("/developer")) });
  }
  if (narrowViewport()) {
    items.push("-");
    items.push({ label: "Phone dashboard", icon: "grid", onClick: () => { setFullAppPreferred(false); renderShell(); } });
  }
  if (!isStandalone()) {
    items.push("-");
    items.push({ label: "Install app", icon: "download", onClick: () => installApp() });
  }
  items.push("-");
  items.push({ label: "Sign out", icon: "logout", danger: true, onClick: signOut });
  menu(anchor, items);
}

async function signOut() {
  try {
    await post("/auth/logout");
  } catch { /* ignore */ }
  store.set({ session: null });
  tabs.closeAll();
  renderAuth();
}

/* ------------------------------------------------------------------------- */
/* Announcements                                                              */
/* ------------------------------------------------------------------------- */
function openAnnouncements(announcements) {
  drawer({
    title: "Announcements",
    subtitle: "Messages from the platform team",
    body: h("div", { class: "col gap-3" }, announcements.map((item) =>
      sectionCard({
        title: item.title,
        subtitle: dateTime(item.created_at),
        body: h("div", { class: "col gap-2" },
          badge(item.level, item.level === "critical" ? "danger" : item.level === "warning" ? "warning" : "info"),
          h("p", { class: "muted small" }, item.body)),
      }))),
  });
}

/* ------------------------------------------------------------------------- */
/* Command palette                                                            */
/* ------------------------------------------------------------------------- */
function openPalette() {
  const actions = [];
  for (const group of navModel()) {
    for (const item of group.items) {
      actions.push({ label: item.label, hint: group.label || "Navigate", icon: item.icon, run: () => router?.go(item.path) });
    }
  }
  if (moduleOn("custom_workspaces")) {
    get("/workspaces").then(({ items }) => {
      for (const workspace of items) {
        actions.push({ label: workspace.name, hint: "Workspace", icon: workspace.icon || "sparkles",
          run: () => router?.go(`/workspaces/${workspace.id}`) });
      }
      render();
    }).catch(() => {});
  }
  actions.push(
    { label: "Open the till", hint: "Action", icon: "cart", run: () => router?.go("/pos") },
    { label: "Start a new sale", hint: "Action", icon: "plus", run: () => router?.go("/pos") },
    { label: "Add a product", hint: "Action", icon: "box", run: () => router?.go("/inventory") },
    { label: "Departments", hint: "Catalog", icon: "layers", run: () => router?.go("/departments") },
    { label: "Lay-bys", hint: "Selling", icon: "wallet", run: () => router?.go("/laybys") },
    { label: "Open reports", hint: "Action", icon: "chart", run: () => router?.go("/reports") },
    ...(moduleOn("barcode") && hasPerm("products.manage")
      ? [{ label: "Barcode studio", hint: "Catalog", icon: "barcode", run: () => router?.go("/barcodes") }]
      : []),
    ...(outboxCount()
      ? [{ label: "Push offline changes", hint: "Sync", icon: "upload", run: () => promptPush() }]
      : []),
    { label: "Change password", hint: "Account", icon: "key", run: () => openPasswordDialog() },
    { label: "Sign out", hint: "Account", icon: "logout", run: signOut },
  );

  const input = h("input", {
    class: "palette__input",
    placeholder: "Search screens and actions…",
    attrs: {
      "aria-label": "Search screens and actions",
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": "palette-list",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const list = h("div", {
    class: "palette__list",
    attrs: { id: "palette-list", role: "listbox", "aria-label": "Results" },
  });
  let filtered = actions;
  let cursor = 0;
  const opener = document.activeElement;

  const overlay = h("div", { class: "overlay palette-overlay" });
  const panel = h("div", {
    class: "palette",
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Search and jump" },
  });
  panel.appendChild(h("div", { class: "palette__search" },
    icon("search"),
    input,
    h("kbd", { class: "palette__esc", attrs: { "aria-hidden": "true" } }, "Esc")));
  panel.appendChild(list);
  panel.appendChild(h("div", { class: "palette__footer", attrs: { "aria-hidden": "true" } },
    h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " navigate"),
    h("span", {}, h("kbd", {}, "↵"), " open"),
    h("span", {}, h("kbd", {}, "Esc"), " close")));
  overlay.appendChild(panel);

  function render() {
    clear(list);
    input.setAttribute("aria-activedescendant", filtered.length ? `palette-item-${cursor}` : "");
    if (!filtered.length) {
      list.appendChild(h("div", { class: "palette__empty", attrs: { role: "status" } }, "No matches. Try a screen name or action."));
      return;
    }
    filtered.forEach((action, index) => {
      const row = h("button", {
        class: `palette__item${index === cursor ? " is-active" : ""}`,
        type: "button",
        id: `palette-item-${index}`,
        attrs: { role: "option", "aria-selected": index === cursor ? "true" : "false" },
        onClick: () => run(action),
        onMouseEnter: () => { cursor = index; render(); },
      }, icon(action.icon || "dot"), h("span", { class: "grow" }, action.label), h("span", { class: "palette__hint" }, action.hint));
      list.appendChild(row);
    });
    list.children[cursor]?.scrollIntoView({ block: "nearest" });
  }

  function run(action) {
    close();
    action.run();
  }

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); cursor = Math.min(filtered.length - 1, cursor + 1); render(); }
    if (e.key === "ArrowUp") { e.preventDefault(); cursor = Math.max(0, cursor - 1); render(); }
    if (e.key === "Home") { e.preventDefault(); cursor = 0; render(); }
    if (e.key === "End") { e.preventDefault(); cursor = Math.max(0, filtered.length - 1); render(); }
    if (e.key === "Enter") { e.preventDefault(); if (filtered[cursor]) run(filtered[cursor]); }
  }

  input.addEventListener("input", () => {
    const term = input.value.toLowerCase().trim();
    filtered = term
      ? actions.filter((action) => `${action.label} ${action.hint}`.toLowerCase().includes(term))
      : actions;
    cursor = 0;
    render();
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  render();
  setTimeout(() => input.focus(), 20);
}

/* ------------------------------------------------------------------------- */
/* Global shortcuts                                                           */
/* ------------------------------------------------------------------------- */
document.addEventListener("keydown", (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (isAuthed()) openPalette();
  }
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    tabs.cycle(e.shiftKey ? -1 : 1);
  }
  if (e.altKey && /^[1-9]$/.test(e.key) && isAuthed()) {
    const flat = navModel().flatMap((group) => group.items);
    const target = flat[Number(e.key) - 1];
    if (target) {
      e.preventDefault();
      router?.go(target.path);
    }
  }
});

window.addEventListener("pos:signed-out", () => {
  store.set({ session: null });
  tabs.closeAll();
  renderAuth("Your session expired. Please sign in again.");
});

/* A terminal switched to a teammate who still has their temporary password (or
   any stale client) is sent straight to the gate instead of hitting dead ends. */
window.addEventListener("pos:password-required", () => {
  const user = currentUser();
  if (!user) return;
  if (!user.must_change_password) {
    const session = getSession();
    store.set({ session: { ...session, user: { ...user, must_change_password: true } } });
  }
  if (shellMode !== "gate") renderShell();
});

/* Expose a tiny helper for views that need a full refresh after big changes. */
export function remountShell() {
  if (isAuthed()) renderShell();
}

window.addEventListener("pos:preferences-changed", () => {
  applySidebarMode(sidebarMode());
  const themeBtn = shellEl?.querySelector('.topbar [title^="Switch to"]');
  if (themeBtn) {
    themeBtn.replaceChildren(icon(themeIconName()));
    themeBtn.title = themeActionLabel();
  }
});

window.addEventListener("pos:branch-changed", () => {
  if (!shellEl || shellMode !== "desktop") return;
  const topbar = shellEl.querySelector(".topbar");
  if (topbar) renderTopbar(topbar);
  corePrefetched = false;
  setTimeout(prefetchCoreReports, 600);
});

window.addEventListener("pos:branch-required", (event) => {
  toast(event.detail?.message || "Switch to a branch to make changes.", "warning");
});

let corePrefetched = false;
function prefetchCoreReports() {
  if (corePrefetched || !currentCompany() || !hasPerm("reports.view")) return;
  if (currentUser()?.must_change_password) return;
  corePrefetched = true;
  const today = isoDay();
  const query = { from: today, to: today, lists: 0, ...branchQuery() };
  setTimeout(() => {
    get("/reports/comparison", query).catch(() => null);
    get("/reports/overview", query).catch(() => null);
  }, 250);
}

window.addEventListener("pos:ready", prefetchCoreReports);

window.addEventListener("pos:session-refreshed", () => {
  if (!shellEl || shellMode !== "desktop") return;
  const topbar = shellEl.querySelector(".topbar");
  if (topbar) renderTopbar(topbar);
});

window.addEventListener("pos:install-available", () => {
  if (!shellEl || shellMode !== "desktop") return;
  const topbar = shellEl.querySelector(".topbar");
  if (topbar) renderTopbar(topbar);
});

window.addEventListener("pos:installed", () => {
  toast("Universal POS is installed. Launch it from your desktop or home screen.", "success", "Installed");
  if (!shellEl || shellMode !== "desktop") return;
  const topbar = shellEl.querySelector(".topbar");
  if (topbar) renderTopbar(topbar);
});

window.addEventListener("pos:branding-changed", () => {
  if (!shellEl) return;
  applyBranding();
  if (shellMode === "mobile") {
    renderShell();
    return;
  }
  const sidebar = shellEl.querySelector(".sidebar");
  const topbar = shellEl.querySelector(".topbar");
  if (sidebar) renderSidebar(sidebar);
  if (topbar) renderTopbar(topbar);
  markActiveNav(sidebar, tabs.current());
});

/* Crossing the phone breakpoint swaps the shell; the choice only applies once. */
(function watchViewport() {
  if (!window.matchMedia) return;
  const query = window.matchMedia(MOBILE_QUERY);
  const onChange = () => {
    if (!isAuthed()) return;
    const narrow = narrowViewport();
    if (shellMode === "gate") {
      // Keep what they typed: the gate is the same layout at every width.
      viewportNarrow = narrow;
      return;
    }
    const wanted = isMobileShell() ? "mobile" : "desktop";
    if (wanted !== shellMode || narrow !== viewportNarrow) renderShell();
  };
  if (query.addEventListener) query.addEventListener("change", onChange);
  else if (query.addListener) query.addListener(onChange);
})();

window.addEventListener("DOMContentLoaded", boot);
initPwa();
window.posApp = { remountShell, store };
