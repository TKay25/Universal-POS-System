/* Fetch wrapper: CSRF, JSON, structured errors, session recovery. */

import { store } from "./store.js";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "error", fields = {} } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields || {};
  }
}

function buildQuery(query) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

let refreshing = null;

async function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const res = await fetch("/api/auth/session", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (data && data.csrf_token) {
      store.set({ csrf: data.csrf_token, session: data.authenticated ? data : null });
    }
    return data;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api(path, { method = "GET", body, query, signal, raw = false, retry = true } = {}) {
  const headers = { Accept: raw ? "*/*" : "application/json" };
  const token = store.state.csrf;
  if (token) headers["X-CSRF-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`/api${path}${buildQuery(query)}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError("The server is unreachable. Check your connection and try again.", {
      status: 0,
      code: "network",
    });
  }

  if (response.status === 419 && retry) {
    await refreshSession();
    return api(path, { method, body, query, signal, raw, retry: false });
  }

  if (raw) {
    if (!response.ok) {
      throw new ApiError("That file could not be downloaded.", { status: response.status });
    }
    return response;
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!response.ok) {
    const error = payload && payload.error ? payload.error : {};
    if (response.status === 401 && !path.startsWith("/auth/")) {
      store.set({ session: null });
      window.dispatchEvent(new CustomEvent("pos:signed-out"));
    }
    throw new ApiError(error.message || `Request failed (${response.status}).`, {
      status: response.status,
      code: error.code || "error",
      fields: error.fields || {},
    });
  }
  return payload;
}

export const get = (path, query, options = {}) => api(path, { query, ...options });
export const post = (path, body, options = {}) => api(path, { method: "POST", body, ...options });
export const patch = (path, body, options = {}) => api(path, { method: "PATCH", body, ...options });
export const del = (path, options = {}) => api(path, { method: "DELETE", ...options });

export async function downloadFile(path, query) {
  const response = await api(path, { raw: true, query });
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match ? match[1] : "export.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export { refreshSession };
