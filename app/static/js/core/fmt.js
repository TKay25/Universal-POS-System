/* Formatting helpers that follow the company's currency and local time. */

import { currency, currentCompany } from "./store.js";

const DEFAULT_TZ = "Africa/Harare";

export function timeZone() {
  return currentCompany()?.timezone || DEFAULT_TZ;
}

export function money(cents, options = {}) {
  const cfg = options.currency || currency();
  const decimals = cfg.decimals ?? 2;
  const raw = (Number(cents) || 0) / 100;
  const negative = raw < 0;
  const formatted = Math.abs(raw).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const symbol = cfg.symbol || "";
  const body = options.bare
    ? formatted
    : cfg.position === "after" ? `${formatted} ${symbol}`.trim() : `${symbol}${formatted}`;
  return negative ? `-${body}` : body;
}

export function moneyValue(cents) {
  return (Number(cents) || 0) / 100;
}

export function toCents(input) {
  if (input == null || input === "") return 0;
  const cleaned = String(input).replace(/[^0-9.\-]/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

export function number(value, digits = 0) {
  const n = Number(value) || 0;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, 3),
  });
}

export function qty(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function percent(value, digits = 1) {
  return `${(Number(value) || 0).toFixed(digits)}%`;
}

export function date(value, opts = {}) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    timeZone: timeZone(),
    day: "2-digit",
    month: "short",
    year: opts.year === false ? undefined : "numeric",
  });
}

export function time(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { timeZone: timeZone(), hour: "2-digit", minute: "2-digit" });
}

export function dateTime(value, opts = {}) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${date(d, opts)} · ${time(d)}`;
}

export function relative(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.round(diff / 86400)}d ago`;
  return date(d);
}

export function isoDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function addDays(days, from = new Date()) {
  const copy = new Date(from);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export const RANGE_PRESETS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 6 },
  { key: "30d", label: "30 days", days: 29 },
  { key: "90d", label: "90 days", days: 89 },
  { key: "365d", label: "1 year", days: 364 },
];

export function rangeFromPreset(key, days) {
  const to = isoDay();
  const from = isoDay(addDays(-(Number(days) || 0)));
  return { from, to, key };
}

export function titleCase(value = "") {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function pluralize(count, singular, plural) {
  return Number(count) === 1 ? singular : plural || `${singular}s`;
}
