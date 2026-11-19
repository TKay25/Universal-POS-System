/* Workspace settings shell: section navigation + renderer host. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { get } from "../core/http.js";
import { hasAny, moduleOn } from "../core/store.js";
import { pageHeader, button, alertBox, modal } from "../core/ui.js";
import { SECTION_RENDERERS } from "./settingsSections.js";

const SECTIONS = [
  { key: "preferences", label: "Your preferences", icon: "sliders", group: "Personal" },
  { key: "general", label: "General", icon: "settings", group: "Workspace", perms: ["settings.manage"] },
  { key: "branding", label: "Branding", icon: "palette", group: "Workspace", perms: ["settings.manage"] },
  { key: "sales", label: "Sales & numbering", icon: "receipt", group: "Workspace", perms: ["settings.manage"] },
  { key: "taxes", label: "Tax rates", icon: "percent", group: "Selling", perms: ["settings.manage"] },
  { key: "payments", label: "Payment methods", icon: "card", group: "Selling", perms: ["settings.manage"] },
  { key: "pos", label: "POS layout", icon: "cart", group: "Selling", perms: ["settings.manage"] },
  { key: "receipts", label: "Receipt designer", icon: "printer", group: "Selling", perms: ["settings.manage"] },
  { key: "discounts", label: "Promotions", icon: "tag", group: "Selling", module: "discounts", perms: ["discounts.manage", "settings.manage"] },
  { key: "modules", label: "Modules", icon: "sparkles", group: "Customisation", perms: ["settings.manage"] },
  { key: "fields", label: "Custom fields", icon: "sliders", group: "Customisation", module: "custom_fields", perms: ["settings.manage"] },
  { key: "workspaces", label: "Custom workspaces", icon: "grid", group: "Customisation", module: "custom_workspaces", perms: ["settings.manage"] },
  { key: "locations", label: "Branches & tills", icon: "map", group: "Operations", perms: ["settings.manage"] },
  { key: "users", label: "Team", icon: "users", group: "People", perms: ["users.manage"] },
  { key: "reports", label: "Report recipients", icon: "whatsapp", group: "People", perms: ["settings.manage"] },
  { key: "roles", label: "Roles & permissions", icon: "shield", group: "People", perms: ["users.manage"] },
  { key: "audit", label: "Activity log", icon: "list", group: "Governance", module: "audit_log", perms: ["audit.view"] },
  { key: "danger", label: "Reset & danger", icon: "warn", group: "Governance", perms: ["settings.manage"] },
];

const sectionAllowed = (entry) =>
  (!entry.perms || hasAny(...entry.perms)) && (!entry.module || moduleOn(entry.module));

export default async function settingsView(ctx) {
  const el = h("div");
  const visible = SECTIONS.filter(sectionAllowed);
  const requested = visible.some((entry) => entry.key === ctx.params.section) ? ctx.params.section : null;
  let section = requested || visible[0]?.key || "preferences";
  const body = h("div", { class: "settings__body" });
  const nav = h("nav", { class: "settings__nav" });

  el.appendChild(pageHeader({
    title: "Workspace settings",
    subtitle: "Shape the POS around the way your business actually runs",
    actions: [
      button("Open the till", { icon: "cart", onClick: () => ctx.navigate("/pos") }),
      hasAny("settings.manage") ? button("Checklist", { icon: "sparkles", variant: "ghost", onClick: showChecklist }) : null,
    ].filter(Boolean),
  }));
  el.appendChild(h("div", { class: "settings" }, nav, body));

  function renderNav() {
    clear(nav);
    let group = "";
    for (const entry of SECTIONS) {
      if (!sectionAllowed(entry)) continue;
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
    const entry = SECTIONS.find((item) => item.key === section);
    if (!entry || !sectionAllowed(entry)) {
      body.appendChild(alertBox("Your role does not allow you to change these settings.", "warning"));
      return;
    }
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
              const target = SECTIONS.find((entry) => entry.key === parts[1] && sectionAllowed(entry));
              section = target ? target.key : "preferences";
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
      const next = visible.some((entry) => entry.key === params.section) ? params.section : section;
      if (next !== section) {
        section = next;
        renderNav();
        renderSection();
      }
    },
  };
}
