/* Developer console: manage every company and user on the platform. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, date, dateTime, isoDay, addDays } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import { store, getSession, isDeveloper, impersonating } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, badge, toast, alertBox, field, textInput,
  textarea, select, modal, confirmDialog, formGrid, statCard, statusBadge, avatar, pagination, emptyState,
  menu, kvList, switchControl, moneyInput,
} from "../core/ui.js";
import { areaChart } from "../core/charts.js";

const SECTIONS = [
  { key: "overview", label: "Overview", icon: "trend" },
  { key: "companies", label: "Companies", icon: "building" },
  { key: "users", label: "Users", icon: "users" },
  { key: "announcements", label: "Announcements", icon: "bell" },
  { key: "audit", label: "Platform audit", icon: "list" },
  { key: "system", label: "System", icon: "settings" },
];

const PLANS = ["starter", "growth", "scale", "unlimited"];

export default async function developerView(ctx) {
  const el = h("div");
  let section = ctx.params.section || "overview";
  const nav = h("div", { class: "chips mb-4" });
  const body = h("div");

  el.appendChild(h("div", { class: "dev-hero mb-4" },
    h("div", { class: "flex items-start gap-3 wrap" },
      h("div", { class: "brand__mark", style: { width: "44px", height: "44px" } }, icon("shield")),
      h("div", { class: "grow" },
        h("div", { class: "flex items-center gap-2 wrap" },
          h("h1", { class: "dev-hero__title" }, "Developer console"),
          h("span", { class: "dev-tag" }, "Platform staff")),
        h("p", { class: "dev-hero__sub" }, "Manage every company, user, module and audit trail in the system.")),
      impersonating()
        ? button("Leave workspace", { icon: "logout", onClick: () => { window.location.hash = "#/developer"; } })
        : null)));

  el.appendChild(nav);
  el.appendChild(body);

  function renderNav() {
    clear(nav);
    for (const entry of SECTIONS) {
      nav.appendChild(h("button", {
        class: `chip${section === entry.key ? " is-active" : ""}`,
        type: "button",
        onClick: () => {
          section = entry.key;
          renderNav();
          renderSection();
          window.history.replaceState({}, "", `#/developer/${entry.key}`);
        },
      }, icon(entry.icon), entry.label));
    }
  }

  async function renderSection() {
    clear(body);
    const loading = h("div", { class: "loading-block" }, h("div", { class: "spinner" }));
    body.appendChild(loading);
    try {
      await SECTIONS_MAP[section](body);
      loading.remove();
    } catch (error) {
      clear(body);
      body.appendChild(alertBox(error.message, "danger"));
    }
  }

  renderNav();
  await renderSection();
  return {
    el,
    onRoute: (params) => {
      const next = SECTIONS.some((entry) => entry.key === params.section) ? params.section : "overview";
      if (next !== section) {
        section = next;
        renderNav();
        renderSection();
      }
    },
  };
}

const SECTIONS_MAP = {};

/* ------------------------------------------------------------------------- */
/* Overview                                                                   */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.overview = async (host) => {
  const data = await get("/developer/overview");
  const stats = data.stats;
  host.appendChild(h("div", { class: "grid grid--kpi mb-4" },
    statCard({ label: "Companies", value: number(stats.companies), icon: "building", foot: `${stats.active_companies_30d} active in 30 days` }),
    statCard({ label: "Users", value: number(stats.users), icon: "users", foot: "Across all workspaces", tone: "accent" }),
    statCard({ label: "Gross volume", value: money(stats.gross_volume_cents), icon: "cash", foot: `${number(stats.sales)} sales processed`, tone: "success" }),
    statCard({ label: "Modules", value: number(stats.modules_available), icon: "sparkles", foot: `${stats.suspended_companies} suspended companies`, tone: stats.suspended_companies ? "warning" : "" })));

  const grid = h("div", { class: "grid grid--dash" });
  grid.appendChild(h("div", { class: "span-8" }, sectionCard({
    title: "Platform sales",
    subtitle: "Last 30 days across every company",
    body: data.growth.length
      ? areaChart({
        points: data.growth.map((row) => row.sales_cents / 100),
        labels: data.growth.map((row) => date(row.date, { year: false })),
        height: 240,
        formatValue: (value) => money(Math.round(value * 100)),
      })
      : emptyState({ icon: "chart", title: "No sales yet" }),
  })));
  grid.appendChild(h("div", { class: "span-4" }, sectionCard({
    title: "Newest companies",
    flush: true,
    body: h("div", { class: "list" }, data.companies.map((company) => h("div", { class: "list__row" },
      h("div", { class: "module-card__icon" }, icon("building")),
      h("div", { class: "grow", style: { minWidth: 0 } },
        h("div", { class: "truncate strong small" }, company.name),
        h("div", { class: "tiny dim" }, `${company.plan} · ${company.user_count} users`)),
      statusBadge(company.status)))),
  })));
  grid.appendChild(h("div", { class: "span-6" }, sectionCard({
    title: "Latest sales",
    flush: true,
    body: table({
      compact: true,
      rows: data.recent_sales,
      empty: { icon: "receipt", title: "No sales yet" },
      columns: [
        { key: "number", label: "Receipt", render: (row) => h("span", { class: "mono small" }, row.number) },
        { key: "customer", label: "Customer", render: (row) => row.customer || "Walk-in" },
        { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
        { key: "total_cents", label: "Total", align: "right", render: (row) => h("span", { class: "strong num" }, money(row.total_cents)) },
      ],
    }),
  })));
  grid.appendChild(h("div", { class: "span-6" }, sectionCard({
    title: "Recent platform activity",
    flush: true,
    body: table({
      compact: true,
      rows: data.recent_audit,
      empty: { icon: "list", title: "No activity yet" },
      columns: [
        { key: "action", label: "Action", render: (row) => h("span", { class: "mono tiny" }, row.action) },
        { key: "summary", label: "Detail", render: (row) => h("span", { class: "small" }, row.summary || "—") },
        { key: "created_at", label: "When", align: "right", render: (row) => h("span", { class: "tiny dim" }, dateTime(row.created_at)) },
      ],
    }),
  })));
  host.appendChild(grid);
};

/* ------------------------------------------------------------------------- */
/* Companies                                                                  */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.companies = async (host) => {
  const tableHost = h("div");
  const search = textInput({ placeholder: "Search companies…", className: "input--sm" });
  let page = 1;
  const filters = { q: "", status: "" };

  search.addEventListener("input", debounce(() => { filters.q = search.value.trim(); page = 1; load(); }, 250));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/developer/companies", { q: filters.q, status: filters.status, page, per_page: 25 });
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "building", title: "No companies", text: "Create the first workspace on the platform." },
        columns: [
          {
            key: "name", label: "Company",
            render: (row) => h("div", { class: "flex items-center gap-2" },
              h("div", { class: "module-card__icon" }, icon("building")),
              h("div", {},
                h("div", { class: "strong" }, row.name),
                h("div", { class: "tiny dim mono" }, row.slug))),
          },
          { key: "plan", label: "Plan", render: (row) => badge(row.plan, "primary") },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
          { key: "user_count", label: "Users", align: "right", render: (row) => number(row.user_count) },
          { key: "product_count", label: "Products", align: "right", render: (row) => number(row.product_count) },
          { key: "sales_cents", label: "Sales", align: "right", render: (row) => money(row.sales_cents) },
          { key: "created_at", label: "Joined", render: (row) => h("span", { class: "dim small" }, date(row.created_at)) },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              button("Enter", { size: "sm", icon: "external", onClick: () => enter(row) }),
              iconButton("more", { size: "sm", variant: "ghost", title: "Manage", onClick: (e) => openMenu(e.currentTarget, row) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function openMenu(anchor, company) {
    menu(anchor, [
      { label: "Enter workspace", icon: "external", onClick: () => enter(company) },
      { label: "Edit company", icon: "edit", onClick: () => openEdit(company) },
      company.status === "suspended"
        ? { label: "Reactivate", icon: "check", onClick: () => setStatus(company, "active") }
        : { label: "Suspend", icon: "lock", danger: true, onClick: () => setStatus(company, "suspended") },
      { label: "Reset owner password", icon: "key", onClick: () => resetOwner(company) },
      "-",
      { label: "Delete company", icon: "trash", danger: true, onClick: () => remove(company) },
    ]);
  }

  async function enter(company) {
    try {
      const session = await post(`/auth/enter-company/${company.id}`);
      store.set({ session, csrf: session.csrf_token });
      toast(`Entered ${company.name}.`, "success");
      setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function setStatus(company, status) {
    try {
      await patch(`/developer/companies/${company.id}`, { status });
      toast(`${company.name} is now ${status}.`, "success");
      load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function resetOwner(company) {
    const detail = await get(`/developer/companies/${company.id}`);
    const owners = (detail.users || []).filter((user) => user.role === "Owner");
    const target = owners[0] || detail.users[0];
    if (!target) {
      toast("This company has no users yet.", "warning");
      return;
    }
    const password = textInput({ type: "password", placeholder: "New password (min 8)" });
    const errorHost = h("div");
    const instance = modal({
      title: `Reset password · ${target.full_name}`,
      subtitle: company.name,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, field({ label: "New password", control: password })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Reset", { variant: "primary", onClick: async () => {
        try {
          await patch(`/developer/users/${target.id}`, { password: password.value });
          toast("Password reset.", "success");
          instance.close();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  async function remove(company) {
    const ok = await confirmDialog({
      title: `Delete ${company.name}?`,
      message: "This permanently removes the company, its users, products, sales and audit history.",
      confirmLabel: "Delete everything",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/developer/companies/${company.id}`);
      toast("Company deleted.", "success");
      load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function openEdit(company) {
    const name = textInput({ value: company.name });
    const plan = select({ value: company.plan, options: PLANS });
    const status = select({ value: company.status, options: ["active", "trial", "suspended"] });
    const contact = textInput({ value: company.contact_email || "" });
    const timezone = textInput({ value: company.timezone || "UTC" });
    const errorHost = h("div");
    const instance = modal({
      title: `Edit ${company.name}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name }),
        formGrid([field({ label: "Plan", control: plan }), field({ label: "Status", control: status })]),
        field({ label: "Contact email", control: contact }),
        field({ label: "Timezone", control: timezone })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Save", { variant: "primary", onClick: async () => {
        try {
          await patch(`/developer/companies/${company.id}`, {
            name: name.value.trim(), plan: plan.value, status: status.value,
            contact_email: contact.value.trim(), timezone: timezone.value.trim(),
          });
          toast("Company updated.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function openCreate() {
    const name = textInput({ placeholder: "Company name" });
    const plan = select({ value: "starter", options: PLANS });
    const status = select({ value: "active", options: ["active", "trial", "suspended"] });
    const currencyCode = textInput({ value: "USD" });
    const currencySymbol = textInput({ value: "$" });
    const ownerName = textInput({ placeholder: "Owner full name" });
    const ownerEmail = textInput({ type: "email", placeholder: "owner@company.com" });
    const ownerPassword = textInput({ type: "password", placeholder: "At least 8 characters" });
    const errorHost = h("div");
    const instance = modal({
      title: "Create a company",
      subtitle: "Provisioning includes roles, a register and default payment methods",
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Company name", control: name, required: true }),
        formGrid([
          field({ label: "Plan", control: plan }),
          field({ label: "Status", control: status }),
          field({ label: "Currency code", control: currencyCode }),
          field({ label: "Currency symbol", control: currencySymbol }),
        ]),
        h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Owner account (optional)"),
        formGrid([
          field({ label: "Owner name", control: ownerName }),
          field({ label: "Owner email", control: ownerEmail }),
        ]),
        field({ label: "Owner password", control: ownerPassword, hint: "Required when an owner email is set." })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Create company", { variant: "primary", onClick: async () => {
        try {
          await post("/developer/companies", {
            name: name.value.trim(),
            plan: plan.value,
            status: status.value,
            currency_code: currencyCode.value.trim(),
            currency_symbol: currencySymbol.value.trim(),
            owner_name: ownerName.value.trim(),
            owner_email: ownerEmail.value.trim(),
            owner_password: ownerPassword.value,
          });
          toast("Company created.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(sectionCard({
    title: "Companies",
    subtitle: "Every tenant on the platform",
    flush: true,
    actions: h("div", { class: "flex gap-2" },
      h("div", { style: { width: "210px" } }, search),
      button("Create company", { variant: "primary", icon: "plus", onClick: openCreate })),
    body: tableHost,
  }));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Users                                                                      */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.users = async (host) => {
  const tableHost = h("div");
  const search = textInput({ placeholder: "Search people or emails…", className: "input--sm" });
  let page = 1;
  const filters = { q: "" };

  search.addEventListener("input", debounce(() => { filters.q = search.value.trim(); page = 1; load(); }, 250));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/developer/users", { q: filters.q, page, per_page: 30 });
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "users", title: "No users found" },
        columns: [
          {
            key: "full_name", label: "User",
            render: (row) => h("div", { class: "flex items-center gap-2" },
              avatar(row.full_name, row.avatar_color, "sm"),
              h("div", {}, h("div", { class: "strong" }, row.full_name),
                h("div", { class: "tiny dim" }, row.email))),
          },
          { key: "company", label: "Company", render: (row) => row.company || "—" },
          { key: "role", label: "Role", render: (row) => badge(row.role || "—", "primary") },
          { key: "status", label: "Status", render: (row) => statusBadge(row.status) },
          { key: "last_login_at", label: "Last seen", render: (row) => h("span", { class: "dim small" }, row.last_login_at ? dateTime(row.last_login_at) : "Never") },
          {
            key: "actions", label: "", align: "right",
            render: (row) => h("div", { class: "table-actions" },
              iconButton("key", { size: "sm", variant: "ghost", title: "Reset password", onClick: () => openReset(row) }),
              iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openEdit(row) }),
              iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: () => remove(row) })),
          },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function openReset(user) {
    const password = textInput({ type: "password", placeholder: "New password" });
    const errorHost = h("div");
    const instance = modal({
      title: `Reset password · ${user.full_name}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost, field({ label: "New password", control: password })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Reset", { variant: "primary", onClick: async () => {
        try {
          await patch(`/developer/users/${user.id}`, { password: password.value });
          toast("Password updated.", "success");
          instance.close();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  async function openEdit(user) {
    const name = textInput({ value: user.full_name });
    const email = textInput({ type: "email", value: user.email });
    const status = select({ value: user.status, options: ["active", "invited", "disabled"] });
    const pin = textInput({ placeholder: "Set a terminal PIN (optional)" });
    const roleHost = h("div", { class: "col gap-2" });
    const errorHost = h("div");
    let roleSelect = null;

    if (user.company_id) {
      try {
        const detail = await get(`/developer/companies/${user.company_id}`);
        const roles = detail.roles || [];
        roleSelect = select({
          value: user.role_id || "",
          options: roles.map((role) => ({ value: role.id, label: role.name })),
        });
        roleHost.appendChild(field({ label: "Role", control: roleSelect, hint: "Set to Administrator to appoint another admin." }));
      } catch { /* role picker is optional */ }
    }

    const instance = modal({
      title: `Edit ${user.full_name}`,
      subtitle: user.company || "",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Full name", control: name }),
        field({ label: "Email", control: email }),
        field({ label: "Status", control: status }),
        roleHost,
        field({ label: "Terminal PIN", control: pin })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Save", { variant: "primary", onClick: async () => {
        try {
          const payload = { full_name: name.value.trim(), email: email.value.trim(), status: status.value };
          if (roleSelect && roleSelect.value) payload.role_id = Number(roleSelect.value);
          if (pin.value) payload.pin = pin.value;
          await patch(`/developer/users/${user.id}`, payload);
          toast("User updated.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  async function remove(user) {
    const ok = await confirmDialog({
      title: `Delete ${user.full_name}?`,
      message: "Their sales stay, but the account is removed permanently.",
      confirmLabel: "Delete user",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/developer/users/${user.id}`);
      toast("User deleted.", "success");
      load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  host.appendChild(sectionCard({
    title: "Platform users",
    subtitle: "Every account in every company",
    flush: true,
    actions: h("div", { style: { width: "230px" } }, search),
    body: tableHost,
  }));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Announcements                                                              */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.announcements = async (host) => {
  const listHost = h("div");

  async function load() {
    clear(listHost);
    const data = await get("/developer/announcements");
    if (!data.items.length) {
      listHost.appendChild(emptyState({ icon: "bell", title: "No announcements", text: "Publish a maintenance notice or product update." }));
    }
    for (const item of data.items) {
      listHost.appendChild(h("div", { class: "card card--pad mb-2" },
        h("div", { class: "flex items-start gap-2" },
          h("div", { class: "module-card__icon" }, icon("bell")),
          h("div", { class: "grow" },
            h("div", { class: "flex items-center gap-2" },
              h("div", { class: "strong" }, item.title),
              badge(item.level, item.level === "critical" ? "danger" : item.level === "warning" ? "warning" : "info"),
              item.is_active ? badge("Live", "success") : badge("Hidden")),
            h("div", { class: "small muted mt-1" }, item.body),
            h("div", { class: "tiny dim mt-1" }, `${item.audience === "all" ? "All companies" : "Selected companies"} · ${dateTime(item.created_at)}`)),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
            await del(`/developer/announcements/${item.id}`);
            toast("Announcement removed.", "success");
            load();
          } }))));
    }
  }

  function openCreate() {
    const title = textInput({ placeholder: "e.g. Scheduled maintenance" });
    const bodyText = textarea({ rows: 3, placeholder: "What should companies know?" });
    const level = select({ value: "info", options: [{ value: "info", label: "Info" }, { value: "warning", label: "Warning" }, { value: "critical", label: "Critical" }] });
    const expires = textInput({ type: "number", value: "7", placeholder: "Days" });
    const errorHost = h("div");
    const instance = modal({
      title: "New announcement",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Title", control: title, required: true }),
        field({ label: "Message", control: bodyText }),
        formGrid([field({ label: "Level", control: level }), field({ label: "Expires in (days)", control: expires })])),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Publish", { variant: "primary", onClick: async () => {
        try {
          await post("/developer/announcements", {
            title: title.value.trim(),
            body: bodyText.value.trim(),
            level: level.value,
            audience: "all",
            expires_in_days: Number(expires.value) || 0,
          });
          toast("Announcement published.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(sectionCard({
    title: "Announcements",
    subtitle: "Shown to companies inside the app",
    actions: button("New announcement", { variant: "primary", icon: "plus", onClick: openCreate }),
    body: listHost,
  }));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Audit                                                                      */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.audit = async (host) => {
  const tableHost = h("div");
  const search = textInput({ placeholder: "Search actions or people…", className: "input--sm" });
  let page = 1;
  const filters = { q: "" };
  search.addEventListener("input", debounce(() => { filters.q = search.value.trim(); page = 1; load(); }, 250));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/developer/audit", { q: filters.q, page, per_page: 40 });
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "list", title: "No audit entries" },
        columns: [
          { key: "created_at", label: "When", render: (row) => h("span", { class: "tiny dim" }, dateTime(row.created_at)) },
          { key: "company_name", label: "Company", render: (row) => h("span", { class: "small" }, row.company_name || "—") },
          { key: "action", label: "Action", render: (row) => h("span", { class: "mono tiny" }, row.action) },
          { key: "summary", label: "Detail", render: (row) => h("span", { class: "small" }, row.summary || "—") },
          { key: "actor", label: "Actor", render: (row) => h("div", {}, h("div", { class: "small" }, row.actor), h("div", { class: "tiny dim" }, row.ip || "")) },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (next) => { page = next; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  host.appendChild(sectionCard({
    title: "Platform audit",
    subtitle: "Everything that happened, in order",
    flush: true,
    actions: h("div", { style: { width: "230px" } }, search),
    body: tableHost,
  }));
  await load();
};

/* ------------------------------------------------------------------------- */
/* System                                                                     */
/* ------------------------------------------------------------------------- */
SECTIONS_MAP.system = async (host) => {
  const data = await get("/developer/system");
  const stats = data.stats;
  host.appendChild(h("div", { class: "grid grid--kpi mb-4" },
    statCard({ label: "Companies", value: number(stats.companies), icon: "building" }),
    statCard({ label: "Sales processed", value: number(stats.sales), icon: "receipt", tone: "accent" }),
    statCard({ label: "Products", value: number(stats.products), icon: "box", tone: "success" }),
    statCard({ label: "Audit rows", value: number(data.database.audit_rows), icon: "list", tone: "warning" })));

  host.appendChild(sectionCard({
    title: "Module catalog",
    subtitle: `${data.module_catalog.length} modules available to every company`,
    body: h("div", { class: "grid grid--3" },
      data.module_catalog.map((module) => h("div", { class: "card card--pad" },
        h("div", { class: "flex items-center gap-2" },
          h("div", { class: "module-card__icon" }, icon(module.icon || "sparkles")),
          h("div", { class: "grow" },
            h("div", { class: "strong small" }, module.name),
            h("div", { class: "tiny dim" }, module.category)),
          module.default ? badge("Default", "success") : badge("Optional"))))),
  }));

  const pruneBtn = button("Prune audit history", { variant: "danger", icon: "trash" });
  pruneBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Prune audit history?",
      message: "Entries older than 365 days will be permanently deleted.",
      confirmLabel: "Prune",
      danger: true,
    });
    if (!ok) return;
    const result = await post("/developer/system/prune-audit", { days: 365 });
    toast(`${result.deleted} old entries removed.`, "success");
    SECTIONS_MAP.system(host).then(() => {});
    clear(host);
    await SECTIONS_MAP.system(host);
  });

  host.appendChild(sectionCard({
    title: "Maintenance",
    subtitle: "Housekeeping for the platform",
    body: h("div", { class: "col gap-3" },
      kvList([
        ["Oldest audit entry", data.database.oldest_audit ? dateTime(data.database.oldest_audit) : "—"],
        ["Server time", dateTime(data.server_time)],
        ["Dashboard widgets", String(data.dashboard_widgets.length)],
        ["Permissions", String(data.permissions.length)],
      ]),
      h("div", { class: "flex gap-2" }, pruneBtn))}));
};
