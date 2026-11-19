/* Device-wide branch context.

   ``all`` is a read-only aggregate view: it is allowed everywhere except the
   point of sale, where a concrete branch is required to take money.
*/

import { getSession, currentCompany } from "./store.js";

export const ALL_BRANCHES = "all";

function storageKey() {
  return `pos-branch-scope:${currentCompany()?.slug || "default"}`;
}

export function branchLocations() {
  return (getSession()?.locations || []).filter((row) => row.is_active !== false);
}

export function branchScope() {
  const locations = branchLocations();
  let raw = "";
  try {
    raw = window.localStorage.getItem(storageKey()) || "";
    if (!raw) {
      const legacy = Number(window.localStorage.getItem(`pos-branch:${currentCompany()?.slug || "default"}`));
      if (legacy && locations.some((row) => row.id === legacy)) raw = String(legacy);
    }
  } catch { /* private mode: fall back to the default */ }

  if (raw === ALL_BRANCHES) {
    return { all: true, locationId: null, location: null, label: "All branches" };
  }
  const id = Number(raw);
  const location = locations.find((row) => row.id === id)
    || locations.find((row) => row.is_default)
    || locations[0]
    || null;
  if (!location) return { all: true, locationId: null, location: null, label: "All branches" };
  return { all: false, locationId: location.id, location, label: location.name };
}

export function isAllBranches() {
  return branchScope().all;
}

export function branchQuery() {
  const scope = branchScope();
  return scope.locationId ? { location_id: scope.locationId } : {};
}

export function setBranchScope(value) {
  const locations = branchLocations();
  const normalized = value === ALL_BRANCHES ? ALL_BRANCHES : String(Number(value) || "");
  if (normalized && normalized !== ALL_BRANCHES && !locations.some((row) => row.id === Number(normalized))) {
    return branchScope();
  }
  try {
    window.localStorage.setItem(storageKey(), normalized || ALL_BRANCHES);
    if (normalized && normalized !== ALL_BRANCHES) {
      window.localStorage.setItem(`pos-branch:${currentCompany()?.slug || "default"}`, normalized);
    }
  } catch { /* private mode: the switch still applies for this page */ }
  const scope = branchScope();
  window.dispatchEvent(new CustomEvent("pos:branch-changed", { detail: scope }));
  return scope;
}

/* Guard operational writes: All branches is an aggregate/read-only view. */
export function requireBranchAction(message = "All branches is read-only. Switch to a branch to make changes.") {
  if (!isAllBranches()) return true;
  window.dispatchEvent(new CustomEvent("pos:branch-required", { detail: { message } }));
  return false;
}
