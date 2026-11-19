/* Personal preferences: saved per signed-in user through /auth/preferences. */

import { patch } from "./http.js";
import { store, getSession, preferences, applyBranding, setTheme } from "./store.js";

/** Save a patch of preferences and keep the session copy in sync. */
export async function savePreferences(values) {
  const { preferences: saved } = await patch("/auth/preferences", values);
  store.set({ session: { ...getSession(), preferences: saved } });
  applyBranding();
  window.dispatchEvent(new CustomEvent("pos:preferences-changed"));
  return saved;
}

/** Flip the light/dark theme for this user. Applies instantly, then persists. */
export async function toggleThemePreference() {
  const before = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = before === "dark" ? "light" : "dark";
  setTheme(next);
  try {
    await savePreferences({ theme: next });
  } catch (error) {
    setTheme(before);
    throw error;
  }
  return next;
}

/** Apply a preference locally before the server round-trip finishes. */
export function rememberPreference(key, value) {
  const session = getSession();
  if (!session) return;
  store.set({ session: { ...session, preferences: { ...(session.preferences || {}), [key]: value } } });
  applyBranding();
}

/** Resolve a POS toggle against the user's personal override, then the workspace value. */
export function posPreference(key, workspaceValue) {
  const stored = preferences()?.pos?.[key];
  return stored === null || stored === undefined ? workspaceValue : Boolean(stored);
}
