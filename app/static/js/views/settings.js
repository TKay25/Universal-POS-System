/* Workspace settings shell: section navigation + renderer host. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { get } from "../core/http.js";
import { hasAny } from "../core/store.js";
import { pageHeader, button, alertBox, modal } from "../core/ui.js";
import { SECTION_RENDERERS } from "./settingsSections.js";

const SECTIONS = [
  { key: "general", label: "General", icon: "settings", group: "Workspace" },
  { key: "branding", label: "Branding", icon: "palette", group: "Workspace" },
  { key: "sales", label: "Sales & numbering", icon: "receipt", group: "Workspace" },
  { key: "taxes", label: "Tax rates", icon: "percent", group: "Selling" },
  { key: "payments", label: "Payment methods", icon: "card", group: "Selling" },
  { key: "pos", label: "POS layout", icon: "cart", group: "Selling" },
  { key: "receipts", label: "Receipt designer", icon: "printer", group: "Selling" },
  { key: "discounts", label: "Promotions", icon: "tag", group: "Selling" },
  { key: "modules", label: "Modules", icon: "sparkles", group: "Customisation" },
  { key: "fields", label: "Custom fields", icon: "sliders", group: "Customisation" },
  { key: "workspaces", label: "Custom workspaces", icon: "grid", group: "Customisation" },
  { key: "locations", label: "Branches & tills", icon: "map", group: "Operations" },
  { key: "users", label: "Team", icon: "users", group: "People", perms: ["users.manage"] },
  { key: "roles", label: "Roles & permissions", icon: "shield", group: "People", perms: ["users.manage"] },
  { key: "audit", label: "Activity log", icon: "list", group: "Governance", perms: ["audit.view"] },
  { key: "danger", label: "Reset & danger", icon: "warn", group: "Governance" },
];

export default async function settingsView(ctx) {
  const el = h("div");
  let section = SECTIONS.some((entry) => entry.key === ctx.params.section) ? ctx.params.section : "general";
  const body = h("div", { class: "settings__body" });
  const nav = h("nav", { class: "settings__nav" });

  el.appendChild(pageHeader({
    title: "Workspace settings",
    subtitle: "Shape the POS around the way your business actually runs",
    actions: [
      button("Open the till", { icon: "cart", onClick: () => ctx.navigate("/pos") }),
      button("Checklist", { icon: "sparkles", variant: "ghost", onClick: showChecklist }),
    ],
  }));
  el.appendChild(h("div", { class: "settings" }, nav, body));

  function renderNav() {
    clear(nav);
    let group = "";
    for (const entry of SECTIONS) {
      if (entry.perms && !hasAny(...entry.perms)) continue;
      if (entry.group !== group) {
        group = entry.group;
        nav.appendChild(h("div", { class: "settings__group" }, group));
      }
      nav.appendChild(h("button", {
        class: `settings__link${section === entry.key ? " is-active" : ""}`,
        type: "button",
        onClick: () => {
          section = entry.key;
          renderNav();
          renderSection();
          window.history.replaceState({}, "", `#/settings/${entry.key}`);
        },
      }, icon(entry.icon), h("span", {}, entry.label)));
    }
  }

  async function renderSection() {
    clear(body);
    const loading = h("div", { class: "loading-block" }, h("div", { class: "spinner" }));
    body.appendChild(loading);
    try {
      await SECTION_RENDERERS[section](body, { refresh: renderSection, navigate: ctx.navigate });
      loading.remove();
    } catch (error) {
      clear(body);
      body.appendChild(alertBox(error.message, "danger"));
    }
  }

  function showChecklist() {
    get("/company/onboarding").then((data) => {
      const list = h("div", { class: "onboarding" });
      for (const step of data.steps) {
        list.appendChild(h("div", {
          class: `onboarding__step${step.done ? " is-done" : ""}`,
          onClick: () => {
            const parts = step.route.replace("#", "").split("/").filter(Boolean);
            instance.close();
            if (parts[0] === "settings" && parts[1]) {
              section = SECTIONS.some((entry) => entry.key === parts[1]) ? parts[1] : "general";
              renderNav();
              renderSection();
            } else if (ctx.navigate) {
              ctx.navigate(`/${parts[0]}`);
            }
          },
        },
        h("span", { class: "onboarding__check" }, icon("check")),
        h("span", { class: "onboarding__label grow" }, step.label),
        h("span", { class: "tiny dim" }, step.hint),
        icon("chevronRight")));
      }
      const instance = modal({
        title: "Workspace checklist",
        subtitle: `${data.completed} of ${data.total} complete`,
        body: h("div", { class: "col gap-3" },
          h("div", { class: "progress" }, h("div", { class: "progress__bar", style: { width: `${data.percent}%` } })),
          list),
        footer: [button("Close", { onClick: () => instance.close() })],
      });
    }).catch(() => {});
  }

  renderNav();
  await renderSection();
  return {
    el,
    onRoute: (params) => {
      const next = SECTIONS.some((entry) => entry.key === params.section) ? params.section : "general";
      if (next !== section) {
        section = next;
        renderNav();
        renderSection();
      }
    },
  };
}
