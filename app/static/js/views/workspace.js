/* Company-defined custom workspace: generated form, table and CSV export. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { dateTime, date, number } from "../core/fmt.js";
import { get, post, patch, del, downloadFile } from "../core/http.js";
import { hasPerm } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, table, badge, toast, alertBox, field, textInput,
  textarea, select, switchControl, modal, confirmDialog, emptyState, statusBadge, pagination,
} from "../core/ui.js";

export default async function workspaceView(ctx) {
  const id = Number(ctx.params.id);
  const el = h("div");
  const tableHost = h("div");
  const filters = { q: "", page: 1 };
  let workspace = null;
  let records = [];

  const search = textInput({ placeholder: "Search records…", className: "input--sm" });
  search.addEventListener("input", debounce(() => { filters.q = search.value.trim(); filters.page = 1; load(); }, 250));

  const headerHost = h("div");

  el.appendChild(headerHost);
  el.appendChild(sectionCard({
    title: "Records",
    flush: true,
    actions: h("div", { class: "flex gap-2" },
      h("div", { style: { width: "220px" } }, search),
      button("Export CSV", { icon: "download", onClick: async () => {
        await downloadFile(`/workspaces/${id}/records.csv`);
        toast("Export downloaded.", "success");
      } })),
    body: tableHost,
  }));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get(`/workspaces/${id}/records`, { q: filters.q, page: filters.page, per_page: 40 });
      workspace = data.workspace;
      records = data.items;
      renderHeader();
      clear(tableHost);
      const columns = (workspace.fields || []).map((definition) => ({
        key: definition.key,
        label: definition.label,
        render: (record) => renderValue(record.data?.[definition.key], definition),
      }));
      columns.push({ key: "created_at", label: "Created", render: (record) => h("span", { class: "tiny dim" }, dateTime(record.created_at)) });
      columns.push({ key: "created_by", label: "By", render: (record) => h("span", { class: "dim small" }, record.created_by || "—") });
      columns.push({
        key: "actions", label: "", align: "right",
        render: (record) => h("div", { class: "table-actions" },
          iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(record) }),
          hasPerm("settings.manage")
            ? iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
              const ok = await confirmDialog({ title: "Delete this record?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              await del(`/workspaces/${id}/records/${record.id}`);
              toast("Record deleted.", "success");
              load();
            } })
            : null),
      });
      tableHost.appendChild(table({
        rows: data.items,
        onRowClick: (record) => openForm(record),
        empty: {
          icon: "sparkles",
          title: "No records yet",
          text: `Add the first entry to ${workspace.name}.`,
          action: button("New record", { variant: "primary", icon: "plus", onClick: () => openForm() }),
        },
        columns,
      }));
      tableHost.appendChild(pagination(data.meta, (page) => { filters.page = page; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderHeader() {
    clear(headerHost);
    headerHost.appendChild(pageHeader({
      title: workspace.name,
      subtitle: workspace.description || "A workspace your team defined",
      actions: [
        badge(`${workspace.record_count} records`, "primary"),
        button("New record", { variant: "primary", icon: "plus", onClick: () => openForm() }),
      ],
    }));
  }

  function renderValue(value, definition) {
    if (value === null || value === undefined || value === "") return h("span", { class: "dim" }, "—");
    if (definition.type === "bool") return value ? badge("Yes", "success") : badge("No");
    if (definition.type === "date") return date(value);
    if (definition.type === "number") return h("span", { class: "num" }, number(value, 2));
    if (definition.type === "textarea") {
      return h("span", { class: "truncate", style: { maxWidth: "320px", display: "inline-block" }, title: String(value) }, String(value));
    }
    return String(value);
  }

  function openForm(record = null) {
    const inputs = [];
    const fieldsHost = h("div", { class: "col gap-3" });
    for (const definition of workspace.fields || []) {
      const current = record?.data?.[definition.key] ?? "";
      let control;
      if (definition.type === "textarea") control = textarea({ value: current, rows: 3 });
      else if (definition.type === "number") control = textInput({ type: "number", step: "0.01", value: current });
      else if (definition.type === "date") control = textInput({ type: "date", value: current ? String(current).slice(0, 10) : "" });
      else if (definition.type === "select") {
        control = select({
          value: current,
          options: [{ value: "", label: "—" }, ...definition.options.map((option) => ({ value: option, label: option }))],
        });
      } else if (definition.type === "bool") control = switchControl({ checked: Boolean(current) });
      else control = textInput({ value: current });
      inputs.push({ definition, control });
      fieldsHost.appendChild(field({ label: definition.label, required: definition.required, control }));
    }
    const errorHost = h("div");
    const instance = modal({
      title: record ? "Edit record" : `New ${workspace.name} record`,
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost, fieldsHost),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(record ? "Save" : "Create", { variant: "primary", onClick: async () => {
        const data = {};
        for (const { definition, control } of inputs) {
          if (definition.type === "bool") data[definition.key] = control.input.checked;
          else if (control.value !== "") data[definition.key] = control.value;
        }
        try {
          if (record) await patch(`/workspaces/${id}/records/${record.id}`, { data });
          else await post(`/workspaces/${id}/records`, { data });
          toast("Record saved.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  await load();
  return { el };
}
