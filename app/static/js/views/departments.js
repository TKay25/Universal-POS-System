/* Departments: top-level groups with their categories underneath. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { number, dateTime } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import { hasPerm, moduleOn } from "../core/store.js";
import {
  pageHeader, sectionCard, button, iconButton, badge, toast, alertBox, field, textInput, textarea,
  select, switchControl, modal, confirmDialog, emptyState, statCard, menu, formGrid,
} from "../core/ui.js";

const COLORS = ["#5b5bd6", "#b45309", "#d97706", "#0f766e", "#4338ca", "#b91c1c", "#c2410c", "#0891b2", "#7c3aed"];
const ICONS = ["layers", "box", "wrench", "truck", "grid", "sparkles", "tag", "cash", "building", "percent"];

export default async function departmentsView(ctx) {
  const el = h("div");
  let departments = [];
  let categories = [];
  let term = "";

  const kpiHost = h("div", { class: "grid grid--kpi mb-4" });
  const cardsHost = h("div", { class: "grid grid--3" });

  const searchInput = textInput({ placeholder: "Search departments or categories…", className: "input--sm" });
  searchInput.addEventListener("input", () => {
    term = searchInput.value.trim().toLowerCase();
    renderCards();
  });

  el.appendChild(pageHeader({
    title: "Departments",
    subtitle: "Group categories into the departments your staff think in — Hardware, Kitchenware, Electronics and more",
    actions: [
      searchInput,
      button("Categories", { icon: "tag", onClick: openCategories }),
      hasPerm("products.manage")
        ? button("Add department", { variant: "primary", icon: "plus", onClick: () => openDepartmentForm() })
        : null,
    ].filter(Boolean),
  }));
  el.appendChild(kpiHost);
  el.appendChild(cardsHost);

  async function load() {
    clear(cardsHost);
    cardsHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      if (!moduleOn("departments")) {
        clear(cardsHost);
        cardsHost.appendChild(alertBox("Enable the Departments module under Settings → Modules to group your catalog.", "warning"));
        return;
      }
      const data = await get("/departments");
      departments = data.items;
      const categoryData = await get("/categories");
      categories = categoryData.items;
      renderKpis();
      renderCards();
    } catch (error) {
      clear(cardsHost);
      cardsHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  function renderKpis() {
    clear(kpiHost);
    const active = departments.filter((row) => row.is_active).length;
    const products = departments.reduce((sum, row) => sum + row.product_count, 0);
    const cats = departments.reduce((sum, row) => sum + row.category_count, 0);
    kpiHost.appendChild(statCard({ label: "Departments", value: number(departments.length), icon: "layers", foot: `${active} active` }));
    kpiHost.appendChild(statCard({ label: "Categories", value: number(cats), icon: "tag", foot: "Nested under departments", tone: "accent" }));
    kpiHost.appendChild(statCard({ label: "Products", value: number(products), icon: "box", foot: "Across all departments", tone: "success" }));
    kpiHost.appendChild(statCard({
      label: "Unassigned categories",
      value: number(categories.filter((row) => !row.department_id).length),
      icon: "warn",
      foot: "Not inside a department",
      tone: categories.some((row) => !row.department_id) ? "warning" : "",
    }));
  }

  function renderCards() {
    clear(cardsHost);
    if (!departments.length) {
      cardsHost.appendChild(emptyState({
        icon: "layers",
        title: "No departments yet",
        text: "Create departments like Hardware, Kitchenware or Electronics & Appliances, then put categories under them.",
        action: button("Add department", { variant: "primary", icon: "plus", onClick: () => openDepartmentForm() }),
      }));
      return;
    }
    const visible = term
      ? departments.filter((department) => (
        department.name.toLowerCase().includes(term)
        || (department.description || "").toLowerCase().includes(term)
        || department.categories.some((category) => category.name.toLowerCase().includes(term))
      ))
      : departments;
    if (!visible.length) {
      cardsHost.appendChild(emptyState({
        icon: "search",
        title: "Nothing matched",
        text: `No department or category matches “${searchInput.value.trim()}”.`,
        action: button("Clear search", { onClick: () => { searchInput.value = ""; term = ""; renderCards(); } }),
      }));
      return;
    }
    for (const department of visible) {
      const categoryChips = h("div", { class: "chips mt-2" });
      const listed = term
        ? department.categories.filter((category) => category.name.toLowerCase().includes(term))
        : department.categories;
      for (const category of listed) {
        categoryChips.appendChild(h("button", {
          class: "chip",
          type: "button",
          title: `${category.product_count} products`,
          onClick: () => openCategoryForm(category),
        }, h("span", { class: "chip__dot", style: { background: category.color } }), category.name,
        h("span", { class: "dim" }, ` ${category.product_count}`)));
      }
      if (!department.categories.length) {
        categoryChips.appendChild(h("span", { class: "tiny dim" }, "No categories yet"));
      }

      const card = h("div", { class: "card", style: { opacity: department.is_active ? "1" : ".65" } },
        h("div", { style: { height: "4px", background: department.color } }),
        h("div", { class: "card__body" },
          h("div", { class: "flex items-start gap-2" },
            h("div", { class: "module-card__icon", style: { background: `${department.color}22`, color: department.color } },
              icon(department.icon || "layers")),
            h("div", { class: "grow" },
              h("div", { class: "flex items-center gap-2" },
                h("div", { class: "strong", style: { fontSize: "14.5px" } }, department.name),
                department.is_active ? badge("Active", "success") : badge("Inactive")),
              h("div", { class: "tiny dim" },
                `${department.category_count} categories · ${department.product_count} products`)),
            iconButton("more", { size: "sm", variant: "ghost", title: "Manage", onClick: (e) => openMenu(e.currentTarget, department) })),
          department.description ? h("div", { class: "small muted mt-2" }, department.description) : null,
          h("div", { class: "flex gap-2 mt-3" },
            button("Add category", { size: "sm", icon: "plus", onClick: () => openCategoryForm(null, department) }),
            button("Edit", { size: "sm", variant: "ghost", icon: "edit", onClick: () => openDepartmentForm(department) })),
          categoryChips));
      cardsHost.appendChild(card);
    }
  }

  function openMenu(anchor, department) {
    menu(anchor, [
      { label: "Edit department", icon: "edit", onClick: () => openDepartmentForm(department) },
      { label: "Add category", icon: "plus", onClick: () => openCategoryForm(null, department) },
      {
        label: department.is_active ? "Deactivate" : "Activate",
        icon: department.is_active ? "x" : "check",
        onClick: async () => {
          await patch(`/departments/${department.id}`, { is_active: !department.is_active });
          toast(department.is_active ? "Department deactivated." : "Department activated.", "success");
          load();
        },
      },
      "-",
      {
        label: "Delete department",
        icon: "trash",
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${department.name}?`,
            message: "Its categories and products stay, but become uncategorised under no department.",
            confirmLabel: "Delete",
            danger: true,
          });
          if (!ok) return;
          await del(`/departments/${department.id}`);
          toast("Department deleted.", "success");
          load();
        },
      },
    ]);
  }

  function openDepartmentForm(department = null) {
    const name = textInput({ value: department?.name || "", placeholder: "e.g. Hardware" });
    const description = textInput({ value: department?.description || "", placeholder: "What belongs here?" });
    let color = department?.color || COLORS[departments.length % COLORS.length];
    let chosenIcon = department?.icon || "layers";
    const colorHost = h("div", { class: "thumbs" });
    const iconHost = h("div", { class: "thumbs" });
    const active = switchControl({ checked: department ? department.is_active : true, label: "Active (visible on the till)" });
    const errorHost = h("div");

    function paintColors() {
      clear(colorHost);
      for (const choice of COLORS) {
        const btn = h("button", {
          class: `thumb${color === choice ? " is-active" : ""}`,
          type: "button",
          style: { background: choice, color: "#fff" },
          onClick: () => {
            color = choice;
            paintColors();
          },
        }, color === choice ? icon("check") : "");
        colorHost.appendChild(btn);
      }
    }
    function paintIcons() {
      clear(iconHost);
      for (const choice of ICONS) {
        const btn = h("button", {
          class: `thumb${chosenIcon === choice ? " is-active" : ""}`,
          type: "button",
          title: choice,
          onClick: () => {
            chosenIcon = choice;
            paintIcons();
          },
        }, icon(choice));
        iconHost.appendChild(btn);
      }
    }
    paintColors();
    paintIcons();

    const instance = modal({
      title: department ? `Edit ${department.name}` : "New department",
      subtitle: "Departments sit above categories, categories above products",
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost,
        formGrid([
          field({ label: "Name", control: name, required: true }),
          field({ label: "Description", control: description }),
        ]),
        field({ label: "Colour", control: colorHost }),
        field({ label: "Icon", control: iconHost }),
        active),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(department ? "Save" : "Create", {
        variant: "primary",
        onClick: async () => {
          try {
            const payload = {
              name: name.value.trim(),
              description: description.value.trim(),
              color,
              icon: chosenIcon,
              is_active: active.input.checked,
            };
            if (department) await patch(`/departments/${department.id}`, payload);
            else await post("/departments", payload);
            toast("Department saved.", "success");
            instance.close();
            load();
          } catch (error) {
            clear(errorHost);
            errorHost.appendChild(alertBox(error.message, "danger"));
          }
        },
      })],
    });
  }

  function openCategoryForm(category = null, department = null) {
    const name = textInput({ value: category?.name || "", placeholder: "e.g. TVs" });
    let color = category?.color || department?.color || COLORS[0];
    const colorHost = h("div", { class: "thumbs" });
    const departmentSelect = select({
      value: category?.department_id || department?.id || "",
      options: [{ value: "", label: "No department" }, ...departments.map((row) => ({ value: row.id, label: row.name }))],
    });
    const active = switchControl({ checked: category ? category.is_active : true, label: "Active" });
    const errorHost = h("div");

    function paintColors() {
      clear(colorHost);
      for (const choice of COLORS) {
        const btn = h("button", {
          class: `thumb${color === choice ? " is-active" : ""}`,
          type: "button",
          style: { background: choice, color: "#fff" },
          onClick: () => {
            color = choice;
            paintColors();
          },
        }, color === choice ? icon("check") : "");
        colorHost.appendChild(btn);
      }
    }
    paintColors();

    const instance = modal({
      title: category ? `Edit ${category.name}` : "New category",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name, required: true }),
        field({ label: "Department", control: departmentSelect }),
        field({ label: "Colour", control: colorHost }),
        active,
        category ? h("div", { class: "tiny dim" }, `${category.product_count} products in this category`) : null),
      footer: [
        category && hasPerm("products.manage")
          ? button("Delete", { variant: "ghost", danger: true, onClick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${category.name}?`,
              message: "Products in this category become uncategorised.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            await del(`/categories/${category.id}`);
            toast("Category deleted.", "success");
            instance.close();
            load();
          } })
          : null,
        button("Cancel", { onClick: () => instance.close() }),
        button(category ? "Save" : "Create", {
          variant: "primary",
          onClick: async () => {
            try {
              const payload = {
                name: name.value.trim(),
                color,
                department_id: departmentSelect.value ? Number(departmentSelect.value) : null,
                is_active: active.input.checked,
              };
              if (category) await patch(`/categories/${category.id}`, payload);
              else await post("/categories", payload);
              toast("Category saved.", "success");
              instance.close();
              load();
            } catch (error) {
              clear(errorHost);
              errorHost.appendChild(alertBox(error.message, "danger"));
            }
          },
        }),
      ].filter(Boolean),
    });
  }

  function openCategories() {
    const body = h("div", { class: "col gap-2" });
    const render = () => {
      clear(body);
      for (const category of categories) {
        body.appendChild(h("div", { class: "flex items-center gap-2", style: { padding: "8px 0", borderBottom: "1px solid var(--border)" } },
          h("span", { class: "chip__dot", style: { background: category.color, width: "10px", height: "10px" } }),
          h("div", { class: "grow" },
            h("div", { class: "strong small" }, category.name),
            h("div", { class: "tiny dim" }, `${category.department || "No department"} · ${category.product_count} products`)),
          iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => {
            instance.close();
            openCategoryForm(category);
          } })));
      }
      if (!categories.length) body.appendChild(emptyState({ icon: "tag", title: "No categories yet" }));
    };
    render();
    const instance = modal({
      title: "All categories",
      subtitle: "Quick edit for every category in the workspace",
      size: "md",
      body,
      footer: [
        button("New category", { icon: "plus", onClick: () => {
          instance.close();
          openCategoryForm();
        } }),
        button("Close", { variant: "primary", onClick: () => instance.close() }),
      ],
    });
  }

  ctx.tab?.setTitle?.("Departments");
  await load();
  return { el };
}
