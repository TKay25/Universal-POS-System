/* Activity log: every action recorded in this workspace, straight from the audit trail. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { dateTime } from "../core/fmt.js";
import { get } from "../core/http.js";
import { pageHeader, sectionCard, button, table, badge, alertBox, loadingBlock,
  pagination, drawer, select, kvList, subtleLabel, searchLoader } from "../core/ui.js";
import { withButtonSpinner } from "../core/loading.js";

const AREA_TONES = {
  sale: "success",
  product: "info",
  stock: "warning",
  inventory: "info",
  category: "info",
  department: "info",
  customer: "info",
  user: "warning",
  role: "warning",
  settings: "",
  module: "",
  tax: "",
  payment_method: "",
  location: "",
  register: "",
  shift: "info",
  layby: "info",
  discount: "",
  supplier: "",
  workspace: "",
  auth: "",
  developer: "danger",
};

function humanise(action = "") {
  const text = String(action).replace(/[._]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Activity";
}

export default async function activityView(ctx) {
  const el = h("div");
  const state = { page: 1, term: "", area: "", actor: "", entity: "", from: "", to: "" };
  let facets = { areas: [], entities: [], actors: [] };

  const content = h("div");
  const searchInput = searchLoader(h("input", { class: "input", placeholder: "Search action, detail or person…", style: { minWidth: "220px" } }));
  const areaHost = h("div");
  const actorHost = h("div");
  const fromInput = h("input", { class: "input input--sm", type: "date", style: { width: "150px" } });
  const toInput = h("input", { class: "input input--sm", type: "date", style: { width: "150px" } });

  el.appendChild(pageHeader({
    title: "Activity log",
    subtitle: "Everything anyone did in this workspace — sales, stock, settings, people",
    actions: [
      button("Refresh", { icon: "refresh", variant: "ghost", onClick: (event) => withButtonSpinner(event.currentTarget, () => load(state.page)) }),
    ],
  }));

  el.appendChild(h("div", { class: "report-toolbar" },
    h("div", { class: "report-toolbar__group" }, searchInput, areaHost, actorHost),
    h("div", { class: "report-toolbar__group report-toolbar__group--end" },
      h("span", { class: "report-toolbar__label" }, "From"), fromInput,
      h("span", { class: "report-toolbar__label" }, "To"), toInput)));
  el.appendChild(content);

  searchInput.addEventListener("input", () => {
    state.term = searchInput.value.trim();
    clearTimeout(searchInput._timer);
    searchInput._timer = setTimeout(() => load(1), 260);
  });
  fromInput.addEventListener("change", () => { state.from = fromInput.value; load(1); });
  toInput.addEventListener("change", () => { state.to = toInput.value; load(1); });

  function renderFilters() {
    clear(areaHost);
    clear(actorHost);
    areaHost.appendChild(select({
      value: state.area,
      options: [
        { value: "", label: "All areas" },
        ...facets.areas.map((area) => ({ value: area.key, label: `${humanise(area.key)} (${area.count})` })),
      ],
      onChange: (event) => { state.area = event.target.value; load(1); },
    }));
    actorHost.appendChild(select({
      value: state.actor,
      options: [
        { value: "", label: "Everyone" },
        ...facets.actors.map((actor) => ({ value: actor.id, label: `${actor.name} (${actor.count})` })),
      ],
      onChange: (event) => { state.actor = event.target.value; load(1); },
    }));
  }

  async function loadFacets() {
    try {
      facets = await get("/activity/facets");
      renderFilters();
    } catch { /* filters are optional */ }
  }

  async function load(page = state.page) {
    state.page = page;
    clear(content);
    content.appendChild(loadingBlock("Loading activity"));
    try {
      const query = { page, per_page: 40 };
      if (state.term) query.q = state.term;
      if (state.area) query.area = state.area;
      if (state.actor) query.actor = state.actor;
      if (state.from) query.from = state.from;
      if (state.to) query.to = state.to;
      const data = await get("/activity", query);
      render(data);
    } catch (error) {
      clear(content);
      content.appendChild(alertBox(error.message, "danger"));
    }
  }

  function render(data) {
    clear(content);
    const items = data.items || [];
    content.appendChild(sectionCard({
      title: "Recorded activity",
      subtitle: `${data.meta.total.toLocaleString()} entries · newest first`,
      flush: true,
      actions: (fromInput.value || toInput.value)
        ? button("Clear dates", {
          size: "sm", variant: "ghost",
          onClick: () => { fromInput.value = ""; toInput.value = ""; state.from = ""; state.to = ""; load(1); },
        })
        : null,
      body: h("div", {},
        table({
          rows: items,
          empty: {
            icon: "list",
            title: "Nothing recorded yet",
            text: "Sales, stock changes and settings updates all show up here.",
          },
          onRowClick: (row) => openEntry(row),
          columns: [
            {
              key: "created_at",
              label: "When",
              render: (row) => h("div", {},
                h("div", { class: "strong", style: { fontSize: "12.6px" } }, dateTime(row.created_at)),
                h("div", { class: "tiny dim" }, row.ip || "—")),
            },
            {
              key: "actor",
              label: "Who",
              render: (row) => h("div", {},
                h("div", { style: { fontSize: "12.6px" } }, row.actor),
                h("div", { class: "tiny dim truncate", style: { maxWidth: "190px" } }, row.actor_email || "")),
            },
            {
              key: "action",
              label: "Action",
              render: (row) => h("div", { class: "flex items-center gap-2" },
                badge(humanise(row.action), AREA_TONES[(row.action || "").split(".")[0]] || ""),
                row.entity ? h("span", { class: "tiny dim" }, `${row.entity}${row.entity_id ? ` #${row.entity_id}` : ""}`) : null),
            },
            {
              key: "summary",
              label: "Detail",
              render: (row) => h("span", { class: "small" }, row.summary || h("span", { class: "dim" }, "—")),
            },
          ],
        }),
        pagination(data.meta, (page) => load(page))),
    }));
  }

  function openEntry(row) {
    const pairs = [
      ["When", dateTime(row.created_at)],
      ["Who", row.actor],
      ["Action", row.action],
      ["Entity", row.entity ? `${row.entity}${row.entity_id ? ` #${row.entity_id}` : ""}` : "—"],
      ["Detail", row.summary || "—"],
      ["IP", row.ip || "—"],
    ];
    const metaKeys = Object.keys(row.meta || {});
    drawer({
      title: humanise(row.action),
      subtitle: dateTime(row.created_at),
      body: h("div", { class: "col gap-4" },
        h("div", { class: "flex items-center gap-2" }, icon("clock"), badge(humanise(row.action), AREA_TONES[(row.action || "").split(".")[0]] || "")),
        kvList(pairs),
        metaKeys.length
          ? h("div", {},
            subtleLabel("Recorded values"),
            kvList(metaKeys.map((key) => [humanise(key), typeof row.meta[key] === "object"
              ? JSON.stringify(row.meta[key])
              : String(row.meta[key])])))
          : null),    });
  }

  loadFacets();
  load(1);

  return {
    el,
    refresh: () => load(state.page),
  };
}
