/* Offline outbox.

   Writes made without a connection are kept in this device's storage and only
   sent when the user pushes them. Every entry carries an Idempotency-Key, so a
   retry that actually reached the server the first time returns the original
   answer instead of charging the customer twice.
*/

import { api } from "./http.js";
import { currentCompany } from "./store.js";

const EVT_CHANGE = "pos:outbox-changed";
const EVT_PUSHED = "pos:outbox-pushed";

function storageKey() {
  return `pos:outbox:${currentCompany()?.id ?? "anonymous"}`;
}

function read() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey()) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(items.slice(0, 200)));
  } catch {
    /* private mode: the queue simply cannot survive a reload */
  }
  window.dispatchEvent(new CustomEvent(EVT_CHANGE, { detail: { count: items.length } }));
}

function uuid() {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch { /* older browsers */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function outboxItems() {
  return read();
}

export function outboxCount() {
  return read().length;
}

export function enqueueWrite({ path, method = "POST", body = null, label = "", reference = "" }) {
  const item = {
    id: uuid(),
    key: uuid(),
    path,
    method,
    body,
    label,
    reference,
    queuedAt: new Date().toISOString(),
    error: "",
  };
  write([...read(), item]);
  return item;
}

export function updateItem(id, patch) {
  write(read().map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

export function removeItem(id) {
  write(read().filter((item) => item.id !== id));
}

export function clearOutbox() {
  write([]);
}

export function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/* Push everything, oldest first. A network failure stops the run (the rest stay
   queued); a server rejection keeps the entry with its reason so a human can fix
   it instead of it silently retrying forever. */
export async function pushOutbox({ onItem } = {}) {
  const items = read();
  const result = { pushed: 0, failed: 0, remaining: items.length, problems: [] };
  for (const item of items) {
    try {
      await api(item.path, {
        method: item.method,
        body: item.body,
        headers: { "Idempotency-Key": item.key },
      });
      removeItem(item.id);
      result.pushed += 1;
      result.remaining -= 1;
      onItem?.({ item, ok: true });
    } catch (error) {
      if (error.code === "network") {
        result.remaining = Math.max(result.remaining, 1);
        result.problems.push({ item, message: "Still offline — nothing was lost." });
        break;
      }
      updateItem(item.id, { error: error.message });
      result.failed += 1;
      result.problems.push({ item, message: error.message });
      onItem?.({ item, ok: false, error });
    }
  }
  window.dispatchEvent(new CustomEvent(EVT_PUSHED, { detail: result }));
  return result;
}
