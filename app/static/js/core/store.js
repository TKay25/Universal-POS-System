/* Application state: session, permissions, branding. */

const listeners = new Set();

export const store = {
  state: {
    session: null,
    ready: false,
    csrf: null,
    toasts: [],
  },
  set(patch) {
    Object.assign(this.state, patch);
    listeners.forEach((fn) => fn(this.state));
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export const getSession = () => store.state.session;

export function isAuthed() {
  return Boolean(store.state.session && store.state.session.authenticated);
}

export function currentUser() {
  return getSession()?.user || null;
}

export function isDeveloper() {
  return Boolean(getSession()?.user?.is_developer);
}

export function impersonating() {
  return Boolean(getSession()?.impersonating);
}

export function currentCompany() {
  return getSession()?.company || null;
}

export function companyName() {
  return getSession()?.company?.name || "Platform";
}

export function hasPerm(permission) {
  const user = currentUser();
  if (!user) return false;
  const perms = user.permissions || [];
  return perms.includes("*") || perms.includes(permission);
}

export function hasAny(...permissions) {
  return permissions.some((p) => hasPerm(p));
}

export function moduleOn(key) {
  const modules = getSession()?.modules || {};
  return Boolean(modules[key]?.enabled);
}

export function moduleConfig(key) {
  return getSession()?.modules?.[key]?.config || {};
}

export function settings() {
  return getSession()?.company?.settings || {};
}

export function setting(section, key, fallback = null) {
  const value = settings()?.[section]?.[key];
  return value === undefined || value === null ? fallback : value;
}

export function currency() {
  return settings().currency || { code: "USD", symbol: "$", position: "before", decimals: 2 };
}

/* ---------- branding ------------------------------------------------------ */
export function applyBranding() {
  const root = document.documentElement;
  const session = getSession();
  const branding = session?.company?.settings?.branding || {};
  const primary = branding.primary || "#5b5bd6";
  const accent = branding.accent || "#22d3ee";
  const radius = Number(branding.radius ?? 14);
  const density = branding.density || "comfortable";

  root.style.setProperty("--primary", primary);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--radius", `${radius}px`);
  root.style.setProperty("--radius-lg", `${Math.round(radius * 1.4)}px`);
  root.dataset.density = density;
  root.dataset.theme = branding.theme === "dark" ? "dark" : "light";
  syncThemeColor();

  const logoText = branding.logo_text || session?.company?.name || "";
  root.title = logoText ? `${logoText} · Universal POS` : "Universal POS";
}

/* The installed app paints its status/title bar from this meta tag. */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const dark = document.documentElement.dataset.theme === "dark";
  meta.setAttribute("content", surface || (dark ? "#111624" : "#ffffff"));
}

export function setTheme(mode) {
  document.documentElement.dataset.theme = mode === "dark" ? "dark" : "light";
  syncThemeColor();
}
