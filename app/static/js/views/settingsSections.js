/* All workspace settings sections. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, date, dateTime, isoDay } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import {
  store, getSession, companyName, currentCompany, hasAny, moduleOn, moduleConfig, settings, preferences,
  applyBranding,
} from "../core/store.js";
import { sectionCard, button, iconButton, table, badge, toast, alertBox, field, textInput, textarea, select,
  switchControl, switchRow, modal, confirmDialog, formGrid, moneyInput, tagInput, emptyState, statusBadge,
  avatar, pagination, kvList, segmented, searchLoader } from "../core/ui.js";
import { savePreferences, rememberPreference, posPreference } from "../core/prefs.js";

export const SECTION_RENDERERS = {};

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */
function prefSwitch({ title, hint, checked, save, disabled = false }) {
  const control = switchRow({
    title,
    hint,
    checked,
    disabled,
    onChange: async (value) => {
      try {
        await save(value);
        toast("Preference saved for your account.", "success");
      } catch (error) {
        control.setChecked(!value);
        toast(error.message, "error");
      }
    },
  });
  return control;
}

async function refreshSession() {
  const session = await get("/auth/session");
  store.set({ session, csrf: session.csrf_token });
  applyBranding();
  window.dispatchEvent(new CustomEvent("pos:branding-changed"));
  return session;
}

async function saveSettings(body, message = "Settings saved.") {
  await patch("/company/settings", body);
  await refreshSession();
  if (message) toast(message, "success");
}

async function saveModule(key, payload, message = "Module updated.") {
  await patch(`/company/modules/${key}`, payload);
  await refreshSession();
  if (message) toast(message, "success");
}

function card(title, subtitle, content, actions = null) {
  return sectionCard({ title, subtitle, actions, body: content });
}

function saveButton(label, handler) {
  const btn = button(label, { variant: "primary", icon: "check" });
  btn.addEventListener("click", async () => {
    btn.setLoading(true);
    try {
      await handler();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      btn.setLoading(false);
    }
  });
  return btn;
}

function row(title, hint) {
  return h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650", margin: "12px 0 4px" } }, title || hint);
}

function moduleSwitch(key, title, hint) {
  const control = switchRow({
    title,
    hint,
    checked: moduleOn(key),
    onChange: async (value) => {
      try {
        await saveModule(key, { enabled: value }, "");
        toast(`${title} ${value ? "enabled" : "disabled"}.`, "success");
      } catch (error) {
        control.setChecked(!value);
        toast(error.message, "error");
      }
    },
  });
  return control;
}

/* ------------------------------------------------------------------------- */
/* Personal preferences                                                       */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.preferences = async (host) => {
  const prefs = preferences();
  const workspace = settings();
  const branding = workspace.branding || {};
  const posCfg = moduleConfig("pos");

  const workspaceTheme = branding.theme === "dark" ? "dark" : "light";
  const workspaceDensity = branding.density === "compact" ? "compact" : "comfortable";

  const themeOn = prefSwitch({
    title: "Dark mode",
    hint: `This device only. The workspace default is ${workspaceTheme}.`,
    checked: (prefs.theme || workspaceTheme) === "dark",
    save: (value) => savePreferences({ theme: value ? "dark" : "light" }),
  });

  const densityOn = prefSwitch({
    title: "Compact layout",
    hint: `Tighter spacing for this account. The workspace default is ${workspaceDensity}.`,
    checked: (prefs.density || workspaceDensity) === "compact",
    save: (value) => savePreferences({ density: value ? "compact" : "comfortable" }),
  });

  const sidebarOn = prefSwitch({
    title: "Start with the sidebar expanded",
    hint: "Remembered for every device you sign in from.",
    checked: document.documentElement.dataset.sidebar === "expanded",
    save: (value) => {
      rememberPreference("sidebar", value ? "expanded" : "collapsed");
      return savePreferences({ sidebar: value ? "expanded" : "collapsed" });
    },
  });

  const soundDefault = posCfg.sound_enabled !== false;
  const autoPrintDefault = Boolean(posCfg.auto_print);
  const canSell = hasAny("pos.sell");

  const soundOn = prefSwitch({
    title: "Scan and add sounds",
    hint: canSell ? "Turn the beep off at this till only." : "You need the 'Sell at the POS' permission.",
    checked: posPreference("sound_enabled", soundDefault),
    disabled: !canSell,
    save: (value) => savePreferences({ pos: { sound_enabled: value } }),
  });

  const autoPrintOn = prefSwitch({
    title: "Print receipts automatically",
    hint: canSell ? "Personal override for the workspace receipt setting." : "You need the 'Sell at the POS' permission.",
    checked: posPreference("auto_print", autoPrintDefault),
    disabled: !canSell,
    save: (value) => savePreferences({ pos: { auto_print: value } }),
  });

  const resetPos = button("Follow the workspace again", {
    variant: "ghost",
    size: "sm",
    onClick: async () => {
      try {
        const saved = await savePreferences({ pos: { sound_enabled: null, auto_print: null } });
        const next = saved.pos || {};
        soundOn.setChecked(next.sound_enabled === null || next.sound_enabled === undefined ? soundDefault : Boolean(next.sound_enabled));
        autoPrintOn.setChecked(next.auto_print === null || next.auto_print === undefined ? autoPrintDefault : Boolean(next.auto_print));
        toast("POS switches follow the workspace again.", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    },
  });

  host.appendChild(card("Look and feel", "Saved to your account, not the whole workspace",
    h("div", { class: "col", style: { padding: "2px 0" } },
      themeOn, densityOn, sidebarOn,
      h("div", { class: "flex justify-end mt-2" },
        button("Reset look and feel", {
          variant: "ghost",
          size: "sm",
          onClick: async () => {
            try {
              await savePreferences({ theme: "", density: "", sidebar: "" });
              themeOn.setChecked(workspaceTheme === "dark");
              densityOn.setChecked(workspaceDensity === "compact");
              sidebarOn.setChecked(false);
              toast("Back to the workspace defaults.", "success");
            } catch (error) {
              toast(error.message, "error");
            }
          },
        })))));

  host.appendChild(card("Till switches", "Your own overrides on top of the workspace POS settings",
    h("div", { class: "col", style: { padding: "2px 0" } },
      soundOn, autoPrintOn,
      h("div", { class: "flex justify-end mt-2" }, resetPos))));

  const widgetsHost = h("div", { class: "col", style: { padding: "2px 0" } });
  const catalog = getSession()?.dashboard_widgets || [];
  const stored = preferences().dashboard_widgets;
  const activeWidgets = new Set(Array.isArray(stored) ? stored : (workspace.dashboard?.widgets || []));

  for (const widget of catalog) {
    const control = switchRow({
      title: widget.name,
      hint: widget.size === "sm" ? "KPI tile" : "Panel",
      checked: activeWidgets.has(widget.key),
      onChange: async (value) => {
        if (value) activeWidgets.add(widget.key);
        else activeWidgets.delete(widget.key);
        try {
          await savePreferences({ dashboard_widgets: [...activeWidgets] });
        } catch (error) {
          control.setChecked(!value);
          if (value) activeWidgets.delete(widget.key);
          else activeWidgets.add(widget.key);
          toast(error.message, "error");
        }
      },
    });
    widgetsHost.appendChild(control);
  }

  host.appendChild(card("Dashboard widgets", "Pick the panels you want to see first",
    h("div", { class: "col gap-2" },
      widgetsHost,
      h("div", { class: "flex justify-end" },
        button("Use the workspace dashboard", {
          variant: "ghost",
          size: "sm",
          onClick: async () => {
            try {
              await savePreferences({ dashboard_widgets: null });
              const fallback = new Set(workspace.dashboard?.widgets || []);
              widgetsHost.querySelectorAll(".switch-row").forEach((rowEl, index) => {
                const widget = catalog[index];
                if (widget) rowEl.setChecked(fallback.has(widget.key));
              });
              toast("Showing the workspace dashboard again.", "success");
            } catch (error) {
              toast(error.message, "error");
            }
          },
        })))));
};

/* ------------------------------------------------------------------------- */
/* General                                                                    */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.general = async (host) => {
  const company = currentCompany();
  const cfg = settings();
  const name = textInput({ value: company.name });
  const contact = textInput({ value: company.contact_email || "" });
  const timezone = textInput({ value: company.timezone || "UTC" });
  const currencyCode = textInput({ value: cfg.currency.code });
  const currencySymbol = textInput({ value: cfg.currency.symbol });
  const currencyPosition = select({
    value: cfg.currency.position || "before",
    options: [{ value: "before", label: "Before amount" }, { value: "after", label: "After amount" }],
  });
  const decimals = select({
    value: String(cfg.currency.decimals ?? 2),
    options: [{ value: "0", label: "0" }, { value: "2", label: "2" }, { value: "3", label: "3" }],
  });
  const business = cfg.business || {};
  const legalName = textInput({ value: business.legal_name || "" });
  const taxNumber = textInput({ value: business.tax_number || "", placeholder: "VAT registration number" });
  const companyRegNumber = textInput({ value: business.company_reg_number || "", placeholder: "Company registration number" });
  const phone = textInput({ value: business.phone || "" });
  const whatsapp = textInput({
    value: business.whatsapp_number || "",
    placeholder: "+263 77 123 4567",
    attrs: { inputmode: "tel", autocomplete: "tel" },
  });
  const email = textInput({ value: business.email || "" });
  const website = textInput({ value: business.website || "" });
  const address = textInput({ value: business.address || "" });
  const city = textInput({ value: business.city || "" });
  const country = textInput({ value: business.country || "" });

  host.appendChild(card("Workspace", "How this company appears across the platform",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Workspace name", control: name, required: true }),
        field({ label: "Contact email", control: contact }),
        field({ label: "Timezone", control: timezone, hint: "IANA name, e.g. Africa/Harare" }),
      ]),
      h("div", { class: "flex justify-end" }, saveButton("Save workspace", async () => {
        await patch("/company/profile", {
          name: name.value.trim(),
          contact_email: contact.value.trim(),
          timezone: timezone.value.trim() || "UTC",
        });
        await refreshSession();
        toast("Workspace profile saved.", "success");
      })))));

  host.appendChild(card("Currency", "Every amount in the app follows these settings",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Currency code", control: currencyCode, hint: "USD, GBP, EUR…" }),
        field({ label: "Symbol", control: currencySymbol }),
        field({ label: "Symbol position", control: currencyPosition }),
        field({ label: "Decimal places", control: decimals }),
      ]),
      h("div", { class: "flex justify-end" }, saveButton("Save currency", () => saveSettings({
        currency: {
          code: currencyCode.value.trim().toUpperCase(),
          symbol: currencySymbol.value.trim(),
          position: currencyPosition.value,
          decimals: Number(decimals.value),
        },
      }, "Currency updated."))))));

  host.appendChild(card("Business details", "Printed on receipts, invoices and reports",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Legal / trading name", control: legalName }),
        field({ label: "VAT registration number", control: taxNumber, hint: "ZIMRA VAT number, printed on receipts" }),
        field({ label: "Company registration number", control: companyRegNumber, hint: "Registrar of Companies number" }),
        formGrid([
          field({ label: "Phone", control: phone }),
          field({ label: "WhatsApp", control: whatsapp, required: !isEdit,
            hint: "Used for the 6pm executive summary." }),
        ]),
        field({ label: "WhatsApp number", control: whatsapp, hint: "For the 6pm executive summary. Include the country code." }),
        field({ label: "Email", control: email }),
        field({ label: "Website", control: website }),
        field({ label: "City", control: city }),
        field({ label: "Country", control: country }),
        field({ label: "Address", control: address, span: true }),
      ]),
      h("div", { class: "flex justify-end" }, saveButton("Save business details", () => saveSettings({
        business: {
          legal_name: legalName.value.trim(), tax_number: taxNumber.value.trim(),
          company_reg_number: companyRegNumber.value.trim(),
          phone: phone.value.trim(), email: email.value.trim(), website: website.value.trim(),
          whatsapp_number: whatsapp.value.trim(),
          address: address.value.trim(), city: city.value.trim(), country: country.value.trim(),
        },
      }, "Business details saved."))))));
};

/* ------------------------------------------------------------------------- */
/* Branding                                                                   */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.branding = async (host) => {
  const cfg = settings().branding || {};
  let primary = cfg.primary || "#5b5bd6";
  let accent = cfg.accent || "#22d3ee";
  let logoData = cfg.logo_data_url || "";
  const logoText = textInput({ value: cfg.logo_text || companyName() });
  const radius = textInput({ type: "number", min: "0", max: "32", value: String(cfg.radius ?? 14) });
  const theme = select({ value: cfg.theme || "light", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] });
  const density = select({ value: cfg.density || "comfortable", options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] });

  const primaryInput = h("input", { type: "color", value: primary });
  const accentInput = h("input", { type: "color", value: accent });
  const primaryHex = textInput({ value: primary });
  const accentHex = textInput({ value: accent });

  const logoPreview = h("div", { style: { width: "64px", height: "64px", borderRadius: "16px", display: "grid", placeItems: "center", color: "#fff", fontWeight: "700", fontSize: "20px", overflow: "hidden", flex: "none" } });
  const preview = h("div", { class: "card card--pad", style: { background: "var(--surface-2)" } });

  function renderPreview() {
    logoPreview.style.background = primary;
    clear(logoPreview);
    if (logoData) logoPreview.appendChild(h("img", { src: logoData, style: { width: "100%", height: "100%", objectFit: "cover" } }));
    else logoPreview.appendChild(document.createTextNode((logoText.value || "UP").slice(0, 2).toUpperCase()));

    clear(preview);
    preview.appendChild(h("div", { class: "flex items-center gap-3 wrap" },
      logoPreview,
      h("div", { class: "grow" },
        h("div", { class: "strong", style: { fontSize: "16px" } }, logoText.value || companyName()),
        h("div", { class: "tiny dim" }, "Live preview of your identity")),
      h("button", { class: "btn btn--sm", type: "button", style: { background: primary, borderColor: primary, color: "#fff" } }, "Primary"),
      h("button", { class: "btn btn--sm", type: "button", style: { background: accent, borderColor: accent, color: "#04232a" } }, "Accent")));
    preview.appendChild(h("div", { class: "flex gap-2 mt-3" },
      badge("Sample badge", "primary"), badge("Success", "success"), badge("Warning", "warning"),
      badge("Danger", "danger")));
  }

  primaryInput.addEventListener("input", () => { primary = primaryInput.value; primaryHex.value = primary; renderPreview(); });
  accentInput.addEventListener("input", () => { accent = accentInput.value; accentHex.value = accent; renderPreview(); });
  primaryHex.addEventListener("input", () => {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(primaryHex.value)) { primary = primaryHex.value; primaryInput.value = primary; renderPreview(); }
  });
  accentHex.addEventListener("input", () => {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentHex.value)) { accent = accentHex.value; accentInput.value = accent; renderPreview(); }
  });
  logoText.addEventListener("input", renderPreview);
  renderPreview();

  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/svg+xml", class: "hidden" });
  const drop = h("div", { class: "dropzone", onClick: () => fileInput.click() },
    icon("upload"), h("div", { class: "mt-1" }, "Upload a logo — PNG, JPG or SVG under 300 KB"));
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 300 * 1024) {
      toast("Please choose an image under 300 KB.", "warning");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      logoData = String(reader.result);
      renderPreview();
      toast("Logo loaded — save to publish it.", "info");
    };
    reader.readAsDataURL(file);
  });

  host.appendChild(card("Brand identity", "Colours, logo and the feel of your POS",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Logo text", control: logoText }),
        field({ label: "Primary colour", control: h("div", { class: "color-field" }, primaryInput, primaryHex) }),
        field({ label: "Accent colour", control: h("div", { class: "color-field" }, accentInput, accentHex) }),
        field({ label: "Corner radius", control: radius, hint: "0 = sharp · 32 = very round" }),
        field({ label: "Default theme", control: theme }),
        field({ label: "Interface density", control: density }),
      ]),
      drop,
      fileInput,
      preview,
      h("div", { class: "flex justify-between gap-2" },
        button("Remove logo", { variant: "ghost", onClick: () => { logoData = ""; renderPreview(); toast("Logo will be cleared when you save.", "info"); } }),
        saveButton("Save branding", () => saveSettings({
          branding: {
            logo_text: logoText.value.trim(),
            logo_data_url: logoData,
            primary,
            accent,
            radius: Number(radius.value) || 0,
            theme: theme.value,
            density: density.value,
          },
        }, "Branding updated."))))));
};

/* ------------------------------------------------------------------------- */
/* Sales & numbering                                                          */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.sales = async (host) => {
  const cfg = settings().sales || {};
  const prefix = textInput({ value: cfg.prefix || "REC-" });
  const nextNumber = textInput({ type: "number", value: String(cfg.next_number || 1) });
  const padding = textInput({ type: "number", value: String(cfg.number_padding ?? 5) });
  const allowZero = switchControl({ checked: Boolean(cfg.allow_zero_price), label: "Allow zero-value sales" });
  const showOut = switchControl({ checked: cfg.show_out_of_stock !== false, label: "Show out-of-stock products on the till" });

  const preview = h("div", { class: "change-due" },
    h("span", {}, "Next receipt"), h("span", { class: "mono" }, ""));
  const updatePreview = () => {
    preview.lastChild.textContent = `${prefix.value}${String(nextNumber.value || 1).padStart(Number(padding.value) || 0, "0")}`;
  };
  [prefix, nextNumber, padding].forEach((input) => input.addEventListener("input", updatePreview));
  updatePreview();

  host.appendChild(card("Receipt numbering", "Controls the numbers customers see",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Prefix", control: prefix, hint: "e.g. REC- or AUR-" }),
        field({ label: "Next number", control: nextNumber }),
        field({ label: "Zero padding", control: padding, hint: "5 → REC-00042" }),
      ]),
      preview,
      h("div", { class: "flex justify-end" }, saveButton("Save numbering", () => saveSettings({
        sales: {
          prefix: prefix.value,
          next_number: Number(nextNumber.value) || 1,
          number_padding: Number(padding.value) || 0,
        },
      }, "Numbering updated."))))));

  host.appendChild(card("Selling rules", "Small switches with a big impact on the till",
    h("div", { class: "col" },
      switchRow({
        title: "Allow zero-value sales",
        hint: "Useful for giveaways, warranty replacements or samples.",
        checked: allowZero.input.checked,
        onChange: (value) => { allowZero.input.checked = value; },
      }),
      switchRow({
        title: "Show out-of-stock products",
        hint: "Turn off to hide items you cannot sell right now.",
        checked: showOut.input.checked,
        onChange: (value) => { showOut.input.checked = value; },
      }),
      h("div", { class: "flex justify-end mt-3" }, saveButton("Save selling rules", () => saveSettings({
        sales: { allow_zero_price: allowZero.input.checked, show_out_of_stock: showOut.input.checked },
      }, "Selling rules saved."))))));
};

/* ------------------------------------------------------------------------- */
/* Taxes                                                                      */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.taxes = async (host) => {
  const listHost = h("div");

  async function load() {
    clear(listHost);
    const { items } = await get("/company/taxes");
    listHost.appendChild(table({
      rows: items,
      empty: { icon: "percent", title: "No tax rates yet", text: "Add the rates that apply where you trade." },
      columns: [
        {
          key: "name", label: "Name",
          render: (item) => h("div", {}, h("div", { class: "strong" }, item.name),
            item.is_default ? badge("Default", "primary") : null),
        },
        { key: "rate", label: "Rate", align: "right", render: (item) => h("span", { class: "num strong" }, `${number(item.rate, 2)}%`) },
        { key: "is_inclusive", label: "Pricing", render: (item) => (item.is_inclusive ? badge("Inclusive", "info") : badge("Exclusive")) },
        { key: "is_active", label: "Status", render: (item) => (item.is_active ? badge("Active", "success") : badge("Off")) },
        {
          key: "actions", label: "", align: "right",
          render: (item) => h("div", { class: "table-actions" },
            iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(item) }),
            iconButton("star", { size: "sm", variant: "ghost", title: "Make default", onClick: async () => {
              await patch(`/company/taxes/${item.id}`, { is_default: true });
              toast("Default tax updated.", "success");
              load();
            } }),
            iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
              const ok = await confirmDialog({ title: `Delete ${item.name}?`, message: "Products using this rate must be reassigned first.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              try {
                await del(`/company/taxes/${item.id}`);
                toast("Tax rate deleted.", "success");
                load();
              } catch (error) {
                toast(error.message, "error");
              }
            } })),
        },
      ],
    }));
  }

  function openForm(tax = null) {
    const name = textInput({ value: tax?.name || "", placeholder: "e.g. VAT 15%" });
    const rate = textInput({ type: "number", step: "0.01", min: "0", max: "100", value: tax ? String(tax.rate) : "" });
    const isDefault = switchControl({ checked: Boolean(tax?.is_default), label: "Default rate for new products" });
    const inclusive = switchControl({ checked: Boolean(tax?.is_inclusive), label: "Product prices already include this tax" });
    const errorHost = h("div");
    const instance = modal({
      title: tax ? `Edit ${tax.name}` : "New tax rate",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name, required: true }),
        field({ label: "Rate %", control: rate, required: true }),
        isDefault, inclusive),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(tax ? "Save" : "Add rate", { variant: "primary", onClick: async () => {
        const payload = {
          name: name.value.trim(),
          rate: Number(rate.value) || 0,
          is_default: isDefault.input.checked,
          is_inclusive: inclusive.input.checked,
        };
        try {
          if (tax) await patch(`/company/taxes/${tax.id}`, payload);
          else await post("/company/taxes", payload);
          toast("Tax rate saved.", "success");
          instance.close();
          await refreshSession();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Tax rates", "The multi-rate engine behind every receipt",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-between items-center" },
        moduleOn("tax_engine") ? badge("Tax engine enabled", "success") : badge("Tax engine disabled", "warning"),
        button("Add tax rate", { variant: "primary", icon: "plus", onClick: () => openForm() })),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Payment methods                                                            */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.payments = async (host) => {
  const listHost = h("div");
  const ICONS = ["cash", "card", "phone", "wallet", "bank", "gift", "percent"];

  async function load() {
    clear(listHost);
    const { items } = await get("/company/payment-methods");
    listHost.appendChild(table({
      rows: items,
      empty: { icon: "card", title: "No payment methods", text: "Add at least one so you can take payments." },
      columns: [
        {
          key: "name", label: "Method",
          render: (item) => h("div", { class: "flex items-center gap-2" },
            h("div", { class: "module-card__icon" }, icon(item.icon || "cash")),
            h("div", { class: "strong" }, item.name)),
        },
        { key: "type", label: "Type", render: (item) => badge(item.type) },
        { key: "requires_reference", label: "Reference", render: (item) => (item.requires_reference ? badge("Required", "warning") : h("span", { class: "dim" }, "—")) },
        { key: "opens_drawer", label: "Drawer", render: (item) => (item.opens_drawer ? badge("Opens", "success") : h("span", { class: "dim" }, "—")) },
        { key: "is_active", label: "Status", render: (item) => (item.is_active ? badge("Active", "success") : badge("Off")) },
        {
          key: "actions", label: "", align: "right",
          render: (item) => h("div", { class: "table-actions" },
            iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(item) }),
            iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
              const ok = await confirmDialog({ title: `Delete ${item.name}?`, message: "Past payments keep their history.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              try {
                await del(`/company/payment-methods/${item.id}`);
                toast("Payment method deleted.", "success");
                load();
              } catch (error) {
                toast(error.message, "error");
              }
            } })),
        },
      ],
    }));
  }

  function openForm(method = null) {
    const name = textInput({ value: method?.name || "", placeholder: "e.g. EcoCash" });
    const type = select({
      value: method?.type || "cash",
      options: [
        { value: "cash", label: "Cash" },
        { value: "card", label: "Card" },
        { value: "mobile", label: "Mobile money" },
        { value: "bank", label: "Bank transfer" },
        { value: "credit", label: "Store credit" },
        { value: "other", label: "Other" },
      ],
    });
    let chosenIcon = method?.icon || "cash";
    const iconHost = h("div", { class: "thumbs" });
    for (const choice of ICONS) {
      const btn = h("button", {
        class: `thumb${chosenIcon === choice ? " is-active" : ""}`,
        type: "button",
        title: choice,
        onClick: () => {
          chosenIcon = choice;
          [...iconHost.children].forEach((node) => node.classList.remove("is-active"));
          btn.classList.add("is-active");
        },
      }, icon(choice));
      iconHost.appendChild(btn);
    }
    const requiresReference = switchControl({ checked: Boolean(method?.requires_reference), label: "Ask for a reference / auth code" });
    const opensDrawer = switchControl({ checked: Boolean(method?.opens_drawer), label: "Open the cash drawer" });
    const isActive = switchControl({ checked: method ? method.is_active : true, label: "Active" });
    const errorHost = h("div");
    const instance = modal({
      title: method ? `Edit ${method.name}` : "New payment method",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name, required: true }),
        field({ label: "Type", control: type }),
        field({ label: "Icon", control: iconHost }),
        requiresReference, opensDrawer, isActive),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(method ? "Save" : "Add method", { variant: "primary", onClick: async () => {
        const payload = {
          name: name.value.trim(),
          type: type.value,
          icon: chosenIcon,
          requires_reference: requiresReference.input.checked,
          opens_drawer: opensDrawer.input.checked,
          is_active: isActive.input.checked,
        };
        try {
          if (method) await patch(`/company/payment-methods/${method.id}`, payload);
          else await post("/company/payment-methods", payload);
          toast("Payment method saved.", "success");
          instance.close();
          await refreshSession();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Payment methods", "How customers can pay you",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-end" }, button("Add method", { variant: "primary", icon: "plus", onClick: () => openForm() })),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* POS layout                                                                 */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.pos = async (host) => {
  const cfg = moduleConfig("pos");
  const grid = textInput({ type: "number", min: "2", max: "8", value: String(cfg.grid_columns ?? 4) });
  const quickCash = tagInput({ values: cfg.quick_cash || [], placeholder: "Amount in cents" });
  const showImages = switchControl({ checked: cfg.show_images !== false, label: "Show product icons on tiles" });
  const showStock = switchControl({ checked: cfg.show_stock !== false, label: "Show stock counts on tiles" });
  const autoPrint = switchControl({ checked: Boolean(cfg.auto_print), label: "Print receipts automatically" });
  const sound = switchControl({ checked: cfg.sound_enabled !== false, label: "Play a sound when adding items" });
  const customerRequired = switchControl({ checked: Boolean(cfg.customer_required), label: "Require a customer on every sale" });

  host.appendChild(card("Till layout", "What the cashier sees and how the grid behaves",
    h("div", { class: "col gap-4" },
      formGrid([
        field({ label: "Product grid columns", control: grid, hint: "2 – 8 columns" }),
        field({ label: "Quick cash buttons", control: quickCash, hint: "In minor units — 500 = 5.00" }),
      ]),
      h("div", { class: "col" }, showImages, showStock, autoPrint, sound, customerRequired),
      h("div", { class: "flex justify-end" }, saveButton("Save till layout", () => saveModule("pos", {
        enabled: true,
        config: {
          grid_columns: Number(grid.value) || 4,
          quick_cash: quickCash.getValue(),
          show_images: showImages.input.checked,
          show_stock: showStock.input.checked,
          auto_print: autoPrint.input.checked,
          sound_enabled: sound.input.checked,
          customer_required: customerRequired.input.checked,
        },
      }, "Till layout saved."))))));

  host.appendChild(card("Checkout extras", "Each switch saves the moment you flip it",
    h("div", { class: "col" },
      moduleSwitch("tips", "Tips", "Let customers add a tip by percentage or amount."),
      moduleSwitch("order_notes", "Item notes", "Kitchen notes, gift wrap, special requests."),
      moduleSwitch("rounding", "Cash rounding", "Round the total to the nearest increment."),
      moduleSwitch("service_charge", "Service charge", "Automatically add a percentage to each ticket."),
      moduleSwitch("holders", "Held orders", "Park a cart and resume it later."),
      moduleSwitch("price_overrides", "Price overrides", "Let trusted staff edit a line price."),
      moduleSwitch("layby", "Lay-by", "Reserve goods on a deposit and collect instalments."))));
};

/* ------------------------------------------------------------------------- */
/* Receipt designer                                                           */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.receipts = async (host) => {
  const cfg = moduleConfig("receipts");
  const general = settings().receipts || {};
  const template = select({
    value: cfg.template || "thermal",
    options: [
      { value: "thermal", label: "Thermal 80mm" },
      { value: "minimal", label: "Minimal" },
      { value: "a4", label: "A4 invoice" },
    ],
  });
  const paper = select({
    value: general.paper_width || "80mm",
    options: [{ value: "58mm", label: "58mm" }, { value: "80mm", label: "80mm" }, { value: "A4", label: "A4" }],
  });
  const showLogo = switchControl({ checked: cfg.show_logo !== false, label: "Show company logo" });
  const showBarcode = switchControl({ checked: cfg.show_barcode !== false, label: "Show receipt barcode" });
  const showCashier = switchControl({ checked: cfg.show_cashier !== false, label: "Show cashier name" });
  const footer = textarea({ value: cfg.footer_note || general.thank_you || "", rows: 2 });
  const headerNote = textInput({ value: general.header_note || "" });
  const terms = textarea({ value: general.terms || "", rows: 2 });

  const frame = h("iframe", { title: "Receipt preview" });
  const refreshPreview = () => { frame.src = `/api/company/receipt-preview?t=${Date.now()}`; };
  refreshPreview();

  host.appendChild(h("div", { class: "receipt-designer" },
    h("div", { class: "col gap-4" },
      card("Receipt style", "Printed at the counter or shared with customers",
        h("div", { class: "col gap-4" },
          formGrid([
            field({ label: "Template", control: template }),
            field({ label: "Paper width", control: paper }),
          ]),
          h("div", { class: "col" }, showLogo, showBarcode, showCashier),
          field({ label: "Header note", control: headerNote }),
          field({ label: "Footer / thank-you", control: footer }),
          field({ label: "Terms & returns", control: terms }),
          h("div", { class: "flex justify-end" }, saveButton("Save receipt design", async () => {
            await saveSettings({
              receipts: {
                paper_width: paper.value,
                header_note: headerNote.value.trim(),
                thank_you: footer.value.trim(),
                terms: terms.value.trim(),
              },
            }, "");
            await saveModule("receipts", {
              enabled: true,
              config: {
                template: template.value,
                show_logo: showLogo.input.checked,
                show_barcode: showBarcode.input.checked,
                show_cashier: showCashier.input.checked,
                footer_note: footer.value.trim(),
              },
            }, "Receipt design saved.");
            refreshPreview();
          }))))),
    h("div", { class: "receipt-preview" }, h("div", { class: "receipt-frame" }, frame))));
};

/* ------------------------------------------------------------------------- */
/* Promotions                                                                 */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.discounts = async (host) => {
  const listHost = h("div");

  async function load() {
    clear(listHost);
    const { items } = await get("/company/discounts");
    listHost.appendChild(table({
      rows: items,
      empty: { icon: "tag", title: "No promotions yet", text: "Create a code your customers can use at checkout." },
      columns: [
        {
          key: "name", label: "Promotion",
          render: (item) => h("div", {},
            h("div", { class: "strong" }, item.name),
            item.code ? h("div", { class: "mono tiny", style: { color: "var(--primary)" } }, item.code) : null),
        },
        {
          key: "value", label: "Value", align: "right",
          render: (item) => h("span", { class: "num strong" },
            item.type === "percent" ? `${number(item.value, 2)}%` : money(Math.round(item.value * 100))),
        },
        { key: "min_subtotal_cents", label: "Minimum", align: "right", render: (item) => (item.min_subtotal_cents ? money(item.min_subtotal_cents) : h("span", { class: "dim" }, "—")) },
        { key: "uses", label: "Used", align: "right", render: (item) => (item.max_uses ? `${item.uses} / ${item.max_uses}` : number(item.uses)) },
        { key: "is_valid", label: "Status", render: (item) => (item.is_valid ? badge("Active", "success") : badge("Inactive")) },
        {
          key: "actions", label: "", align: "right",
          render: (item) => h("div", { class: "table-actions" },
            iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
              const ok = await confirmDialog({ title: `Delete ${item.name}?`, message: "Existing sales keep the discount they received.", confirmLabel: "Delete", danger: true });
              if (!ok) return;
              await del(`/company/discounts/${item.id}`);
              toast("Promotion deleted.", "success");
              load();
            } })),
        },
      ],
    }));
  }

  function openForm() {
    const name = textInput({ placeholder: "e.g. Spring sale" });
    const code = textInput({ placeholder: "SPRING10" });
    const type = select({ value: "percent", options: [{ value: "percent", label: "Percentage off" }, { value: "fixed", label: "Fixed amount off" }] });
    const value = textInput({ type: "number", step: "0.01", placeholder: "10" });
    const minimum = moneyInput({ value: "0.00" });
    const maxUses = textInput({ type: "number", value: "0" });
    const errorHost = h("div");
    const instance = modal({
      title: "New promotion",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Name", control: name, required: true }),
        field({ label: "Code", control: code, hint: "Customers type this at the till." }),
        formGrid([field({ label: "Type", control: type }), field({ label: "Value", control: value, required: true })]),
        formGrid([field({ label: "Minimum spend", control: minimum }), field({ label: "Max uses (0 = unlimited)", control: maxUses })]),
      ),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Create promotion", { variant: "primary", onClick: async () => {
        try {
          await post("/company/discounts", {
            name: name.value.trim(),
            code: code.value.trim(),
            type: type.value,
            value: Number(value.value) || 0,
            min_subtotal: minimum.value || "0",
            max_uses: Number(maxUses.value) || 0,
          });
          toast("Promotion created.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Promotions", "Codes and automatic discounts",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-end" }, button("New promotion", { variant: "primary", icon: "plus", onClick: openForm })),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Modules                                                                    */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.modules = async (host) => {
  const data = await get("/company/modules");
  const state = data.modules;
  const catalog = data.catalog;
  const grouped = {};
  for (const module of catalog) {
    grouped[module.category] = grouped[module.category] || [];
    grouped[module.category].push(module);
  }

  const search = textInput({ placeholder: "Find a module…", className: "input--sm" });
  const grid = h("div", { class: "module-grid" });
  const enabledCount = () => Object.values(state).filter((entry) => entry.enabled).length;
  const countBadge = badge(`${enabledCount()} of ${catalog.length} enabled`, "primary");
  const refreshCount = () => {
    countBadge.textContent = `${enabledCount()} of ${catalog.length} enabled`;
  };

  function openConfig(module, current) {
    const controls = [];
    for (const definition of module.schema) {
      const value = current.config?.[definition.key] ?? definition.default;
      let control;
      if (definition.type === "bool") control = switchControl({ checked: Boolean(value) });
      else if (definition.type === "number") control = textInput({ type: "number", min: definition.min, max: definition.max, value: String(value ?? "") });
      else if (definition.type === "money") control = moneyInput({ value: ((Number(value) || 0) / 100).toFixed(2) });
      else if (definition.type === "select") control = select({ value, options: definition.options || [] });
      else if (definition.type === "textarea") control = textarea({ value: value || "", rows: 2 });
      else if (definition.type === "tags") control = tagInput({ values: value || [] });
      else control = textInput({ value: value || "" });
      controls.push({ definition, control });
    }
    const errorHost = h("div");
    const instance = modal({
      title: `${module.name} settings`,
      subtitle: module.description,
      size: "md",
      body: h("div", { class: "col gap-3" },
        errorHost,
        controls.length
          ? controls.map(({ definition, control }) => field({ label: definition.label, hint: definition.help, control }))
          : h("div", { class: "dim small" }, "This module has no settings — just switch it on or off.")),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Save settings", { variant: "primary", onClick: async () => {
        const configPatch = {};
        for (const { definition, control } of controls) {
          if (definition.type === "bool") configPatch[definition.key] = control.input.checked;
          else if (definition.type === "tags") configPatch[definition.key] = control.getValue();
          else configPatch[definition.key] = control.value;
        }
        try {
          await saveModule(module.key, { config: configPatch }, `${module.name} configured.`);
          instance.close();
          clear(host);
          await SECTION_RENDERERS.modules(host);
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function renderGrid(filter = "") {
    clear(grid);
    for (const [category, modules] of Object.entries(grouped)) {
      const filtered = modules.filter((module) => !filter || `${module.name} ${module.description}`.toLowerCase().includes(filter));
      if (!filtered.length) continue;
      grid.appendChild(h("div", { style: { gridColumn: "1 / -1", marginTop: "8px" } },
        h("div", { class: "nav__label", style: { padding: "2px 0" } }, category)));
      for (const module of filtered) {
        const current = state[module.key] || { enabled: module.default, config: module.config };
        const toggle = module.locked ? null : switchControl({
          checked: current.enabled,
          onChange: async (value) => {
            try {
              const result = await patch(`/company/modules/${module.key}`, { enabled: value });
              state[module.key] = result.module;
              cardEl.classList.toggle("is-on", value);
              refreshCount();
              toast(`${module.name} ${value ? "enabled" : "disabled"}.`, "success");
              refreshSession().catch(() => {});
            } catch (error) {
              toggle.setChecked(!value);
              toast(error.message, "error");
            }
          },
        });
        const cardEl = h("div", { class: `module-card${current.enabled ? " is-on" : ""}` },
          h("div", { class: "module-card__head" },
            h("div", { class: "module-card__icon" }, icon(module.icon || "sparkles")),
            h("div", { class: "grow" },
              h("div", { class: "module-card__name" }, module.name),
              h("div", { class: "module-card__desc" }, module.description)),
            module.locked ? badge("Core", "primary") : null),
          h("div", { class: "module-card__foot" },
            h("span", { class: "module-card__cat" }, module.schema.length ? `${module.schema.length} settings` : "No settings"),
            h("div", { class: "grow" }),
            module.schema.length
              ? iconButton("sliders", { size: "sm", variant: "ghost", title: "Configure", onClick: () => openConfig(module, current) })
              : null,
            module.locked ? badge("Always on", "success") : toggle));
        grid.appendChild(cardEl);
      }
    }
  }

  search.addEventListener("input", () => renderGrid(search.value.toLowerCase().trim()));
  host.appendChild(card("Modules", "Compose the POS you need — switch features on, then tune them",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-between items-center gap-2 wrap" },
        countBadge,
        h("div", { style: { width: "220px" } }, search)),
      grid)));
  renderGrid();
};

/* ------------------------------------------------------------------------- */
/* Custom fields                                                              */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.fields = async (host) => {
  if (!moduleOn("custom_fields")) {
    host.appendChild(alertBox("Enable the Custom Fields module under Modules to add your own fields.", "warning"));
    return;
  }
  let items = (await get("/company/custom-fields")).items;
  const listHost = h("div");

  function render() {
    clear(listHost);
    for (const entity of ["product", "customer"]) {
      const rows = items.filter((item) => item.entity === entity);
      listHost.appendChild(row(entity === "product" ? "Product fields" : "Customer fields"));
      if (!rows.length) {
        listHost.appendChild(h("div", { class: "dim small", style: { padding: "4px 0" } }, "No custom fields yet."));
        continue;
      }
      for (const item of rows) {
        listHost.appendChild(h("div", { class: "flex items-center gap-2", style: { padding: "8px 0", borderBottom: "1px solid var(--border)" } },
          h("div", { class: "grow" },
            h("div", { class: "strong small" }, item.label, item.required ? h("span", { style: { color: "var(--danger)" } }, " *") : null),
            h("div", { class: "tiny dim" }, `${item.type}${item.options?.length ? ` · ${item.options.join(", ")}` : ""}`)),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
            await del(`/company/custom-fields/${item.id}`);
            items = items.filter((entry) => entry.id !== item.id);
            render();
            toast("Field removed.", "success");
          } })));
      }
    }
  }
  render();

  function openForm() {
    const entity = select({ value: "product", options: [{ value: "product", label: "Product" }, { value: "customer", label: "Customer" }] });
    const labelInput = textInput({ placeholder: "e.g. Allergens" });
    const type = select({
      value: "text",
      options: [
        { value: "text", label: "Text" }, { value: "textarea", label: "Long text" }, { value: "number", label: "Number" },
        { value: "select", label: "Dropdown" }, { value: "date", label: "Date" }, { value: "bool", label: "Yes / No" },
      ],
    });
    const options = textInput({ placeholder: "Comma separated options" });
    const required = switchControl({ checked: false, label: "Required" });
    const errorHost = h("div");
    const instance = modal({
      title: "New custom field",
      subtitle: "Adds a field to the product or customer editor",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Applies to", control: entity }),
        field({ label: "Label", control: labelInput, required: true }),
        field({ label: "Type", control: type }),
        field({ label: "Options", control: options, hint: "Only used by dropdowns" }),
        required),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Create field", { variant: "primary", onClick: async () => {
        try {
          const { item } = await post("/company/custom-fields", {
            entity: entity.value,
            label: labelInput.value.trim(),
            type: type.value,
            options: options.value.split(",").map((part) => part.trim()).filter(Boolean),
            required: required.input.checked,
          });
          items.push(item);
          render();
          instance.close();
          toast("Field created.", "success");
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Custom fields", "Track the details that matter to your business",
    h("div", { class: "col gap-2" },
      h("div", { class: "flex justify-end" }, button("Add field", { variant: "primary", icon: "plus", onClick: openForm })),
      listHost)));
};

/* ------------------------------------------------------------------------- */
/* Custom workspaces                                                          */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.workspaces = async (host) => {
  let items = (await get("/workspaces")).items;
  const listHost = h("div");

  function render() {
    clear(listHost);
    if (!items.length) {
      listHost.appendChild(emptyState({
        icon: "sparkles",
        title: "Build your first workspace",
        text: "Workspaces are your own tabs with custom form fields — track repairs, jobs, deliveries or anything else.",
        action: button("New workspace", { variant: "primary", icon: "plus", onClick: () => openForm() }),
      }));
      return;
    }
    for (const workspace of items) {
      listHost.appendChild(h("div", { class: "card card--pad mb-2" },
        h("div", { class: "flex items-center gap-2" },
          h("div", { class: "module-card__icon" }, icon(workspace.icon || "sparkles")),
          h("div", { class: "grow" },
            h("div", { class: "strong" }, workspace.name),
            h("div", { class: "tiny dim" }, `${workspace.fields.length} fields · ${workspace.record_count} records`)),
          button("Open", { size: "sm", onClick: () => { window.location.hash = `#/workspaces/${workspace.id}`; } }),
          iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(workspace) }),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
            const ok = await confirmDialog({ title: `Delete ${workspace.name}?`, message: "Every record in this workspace will be deleted.", confirmLabel: "Delete", danger: true });
            if (!ok) return;
            await del(`/workspaces/${workspace.id}`);
            items = items.filter((entry) => entry.id !== workspace.id);
            render();
            toast("Workspace deleted.", "success");
          } }))));
    }
  }
  render();

  function openForm(workspace = null) {
    const name = textInput({ value: workspace?.name || "", placeholder: "e.g. Repairs" });
    const iconName = textInput({ value: workspace?.icon || "sparkles", placeholder: "sparkles, wrench, truck…" });
    const description = textInput({ value: workspace?.description || "", placeholder: "What is this workspace for?" });
    const fieldList = h("div", { class: "col gap-1" });
    const fields = workspace
      ? workspace.fields.map((entry) => ({ ...entry }))
      : [{ label: "Notes", type: "textarea", options: [], required: false }];

    function renderFields() {
      clear(fieldList);
      fields.forEach((definition, index) => {
        const label = textInput({ value: definition.label, className: "input--sm" });
        label.addEventListener("input", () => { definition.label = label.value; });
        const type = select({
          value: definition.type,
          options: [
            { value: "text", label: "Text" }, { value: "textarea", label: "Long text" }, { value: "number", label: "Number" },
            { value: "date", label: "Date" }, { value: "select", label: "Dropdown" }, { value: "bool", label: "Yes / No" },
          ],
        });
        type.addEventListener("change", () => { definition.type = type.value; });
        const options = textInput({ value: (definition.options || []).join(","), placeholder: "Options", className: "input--sm" });
        options.addEventListener("input", () => {
          definition.options = options.value.split(",").map((part) => part.trim()).filter(Boolean);
        });
        const required = switchControl({ checked: Boolean(definition.required) });
        required.input.addEventListener("change", () => { definition.required = required.input.checked; });
        fieldList.appendChild(h("div", { class: "flex gap-2 items-center", style: { padding: "7px 0", borderBottom: "1px solid var(--border)" } },
          h("div", { class: "grow" }, label),
          h("div", { style: { width: "130px" } }, type),
          h("div", { style: { width: "150px" } }, options),
          h("div", { title: "Required" }, required),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Remove", onClick: () => {
            fields.splice(index, 1);
            renderFields();
          } })));
      });
    }
    renderFields();

    const errorHost = h("div");
    const instance = modal({
      title: workspace ? `Edit ${workspace.name}` : "New custom workspace",
      subtitle: "Define the fields once — the form and table are generated for you",
      size: "lg",
      body: h("div", { class: "col gap-3" }, errorHost,
        formGrid([
          field({ label: "Name", control: name, required: true }),
          field({ label: "Icon", control: iconName, hint: "sparkles, wrench, truck, box…" }),
          field({ label: "Description", control: description, span: true }),
        ]),
        h("div", { class: "flex items-center justify-between" },
          h("div", { class: "tiny dim", style: { textTransform: "uppercase", letterSpacing: ".1em", fontWeight: "650" } }, "Fields"),
          button("Add field", { size: "sm", icon: "plus", onClick: () => {
            fields.push({ label: "New field", type: "text", options: [], required: false });
            renderFields();
          } })),
        fieldList),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(workspace ? "Save workspace" : "Create workspace", { variant: "primary", onClick: async () => {
        try {
          const payload = {
            name: name.value.trim(),
            icon: iconName.value.trim() || "sparkles",
            description: description.value.trim(),
            fields: fields.map((entry) => ({ label: entry.label, type: entry.type, options: entry.options, required: entry.required })),
          };
          if (workspace) await patch(`/workspaces/${workspace.id}`, payload);
          else await post("/workspaces", payload);
          items = (await get("/workspaces")).items;
          render();
          instance.close();
          toast("Workspace saved.", "success");
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Custom workspaces", "Your own tabs, forms and tables — no code required",
    h("div", { class: "col gap-2" },
      h("div", { class: "flex justify-end" }, button("New workspace", { variant: "primary", icon: "plus", onClick: () => openForm() })),
      listHost)));
};

/* ------------------------------------------------------------------------- */
/* Locations                                                                  */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.locations = async (host) => {
  const listHost = h("div");

  async function load() {
    clear(listHost);
    const data = await get("/company/locations");
    const branches = data.items;
    const registers = data.registers;

    if (!branches.length) {
      listHost.appendChild(emptyState({
        icon: "map",
        title: "No branches yet",
        text: "Add every shop, branch or warehouse you sell from.",
        action: button("Add branch", { variant: "primary", icon: "plus", onClick: () => openBranch() }),
      }));
      return;
    }

    for (const branch of branches) {
      const branchRegisters = registers.filter((register) => register.location_id === branch.id);
      const registerChips = h("div", { class: "chips mt-2" });
      for (const register of branchRegisters) {
        registerChips.appendChild(h("div", { class: "chip", style: { gap: "6px" } },
          h("span", { class: "chip__dot", style: { background: branch.is_default ? "var(--primary)" : "var(--text-3)" } }),
          h("span", {}, `${register.name}${register.code ? ` · ${register.code}` : ""}`),
          iconButton("edit", { size: "sm", variant: "ghost", title: "Rename till", onClick: () => openRegister(branch, register) }),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Remove till", onClick: async () => {
            const ok = await confirmDialog({ title: `Remove ${register.name}?`, message: "Past sales keep their branch history.", confirmLabel: "Remove", danger: true });
            if (!ok) return;
            await del(`/company/registers/${register.id}`);
            toast("Till removed.", "success");
            load();
          } })));
      }
      if (!branchRegisters.length) registerChips.appendChild(h("span", { class: "tiny dim" }, "No tills yet"));

      listHost.appendChild(h("div", { class: "card card--pad mb-2", style: { opacity: branch.is_active ? "1" : ".68" } },
        h("div", { class: "flex items-center gap-2 wrap" },
          h("div", { class: "module-card__icon" }, icon("map")),
          h("div", { class: "grow", style: { minWidth: "180px" } },
            h("div", { class: "flex items-center gap-2" },
              h("div", { class: "strong" }, branch.name),
              branch.is_default ? badge("Default branch", "primary") : null,
              branch.is_active ? badge("Open", "success") : badge("Closed")),
            h("div", { class: "tiny dim" }, [branch.code, branch.address, branch.phone].filter(Boolean).join(" · ") || "No details yet")),
          button("Add till", { size: "sm", icon: "plus", onClick: () => openRegister(branch) }),
          iconButton("edit", { size: "sm", variant: "ghost", title: "Edit branch", onClick: () => openBranch(branch) }),
          iconButton("star", { size: "sm", variant: "ghost", title: "Make default", onClick: async () => {
            await patch(`/company/locations/${branch.id}`, { is_default: true });
            toast("Default branch updated.", "success");
            load();
          } }),
          iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete branch", onClick: async () => {
            const ok = await confirmDialog({ title: `Delete ${branch.name}?`, message: "Remove its tills first. Past sales stay in reports.", confirmLabel: "Delete", danger: true });
            if (!ok) return;
            try {
              await del(`/company/locations/${branch.id}`);
              toast("Branch deleted.", "success");
              load();
            } catch (error) {
              toast(error.message, "error");
            }
          } })),
        registerChips));
    }
  }

  function openBranch(branch = null) {
    const name = textInput({ value: branch?.name || "", placeholder: "e.g. Avondale Branch" });
    const code = textInput({ value: branch?.code || "", placeholder: "AVN" });
    const address = textInput({ value: branch?.address || "", placeholder: "Address" });
    const phone = textInput({ value: branch?.phone || "", placeholder: "+263 77 123 4567" });
    const isDefault = switchControl({ checked: Boolean(branch?.is_default), label: "Default branch for new sales" });
    const isActive = switchControl({ checked: branch ? branch.is_active : true, label: "Open for trading" });
    const errorHost = h("div");
    const instance = modal({
      title: branch ? `Edit ${branch.name}` : "New branch",
      subtitle: "Create as many branches as you trade from",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        formGrid([field({ label: "Branch name", control: name, required: true }), field({ label: "Code", control: code })]),
        field({ label: "Address", control: address }),
        formGrid([
          field({ label: "Phone", control: phone }),
          field({ label: "WhatsApp", control: whatsapp, required: !isEdit,
            hint: "Used for the 6pm executive summary." }),
        ]),
        isDefault, isActive),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(branch ? "Save branch" : "Add branch", { variant: "primary", onClick: async () => {
        try {
          const payload = {
            name: name.value.trim(), code: code.value.trim(), address: address.value.trim(),
            phone: phone.value.trim(), is_default: isDefault.input.checked, is_active: isActive.input.checked,
          };
          if (branch) await patch(`/company/locations/${branch.id}`, payload);
          else await post("/company/locations", payload);
          toast("Branch saved.", "success");
          instance.close();
          await refreshSession();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  function openRegister(branch, register = null) {
    const name = textInput({ value: register?.name || "", placeholder: "e.g. Counter 2" });
    const code = textInput({ value: register?.code || "", placeholder: "C2" });
    const isActive = switchControl({ checked: register ? register.is_active : true, label: "Active" });
    const errorHost = h("div");
    const instance = modal({
      title: register ? `Edit ${register.name}` : `New till · ${branch.name}`,
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        formGrid([field({ label: "Till name", control: name, required: true }), field({ label: "Code", control: code })]),
        isActive),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(register ? "Save till" : "Add till", { variant: "primary", onClick: async () => {
        try {
          if (register) {
            await patch(`/company/registers/${register.id}`, {
              name: name.value.trim(), code: code.value.trim(), is_active: isActive.input.checked,
            });
          } else {
            await post("/company/registers", {
              name: name.value.trim(), code: code.value.trim(), location_id: branch.id,
              is_active: isActive.input.checked,
            });
          }
          toast("Till saved.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Branches & tills", "Every shop branch under this company, and the tills inside them",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-between items-center wrap gap-2" },
        badge(`${moduleOn("multi_location") ? "Multi-branch enabled" : "Single branch"}`, moduleOn("multi_location") ? "success" : "warning"),
        button("Add branch", { variant: "primary", icon: "plus", onClick: () => openBranch() })),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Team                                                                       */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.users = async (host) => {
  const listHost = h("div");

  async function load() {
    clear(listHost);
    const data = await get("/company/users");
    listHost.appendChild(table({
      rows: data.items,
      empty: { icon: "users", title: "No teammates yet", text: "Invite the people who sell with you." },
      columns: [
        {
          key: "full_name", label: "Teammate",
          render: (user) => h("div", { class: "flex items-center gap-2" },
            avatar(user.full_name, user.avatar_color, "sm"),
            h("div", {}, h("div", { class: "strong" }, user.full_name),
              h("div", { class: "tiny dim" }, user.email))),
        },
        { key: "role", label: "Role", render: (user) => badge(user.role || "No role", "primary") },
        { key: "whatsapp", label: "WhatsApp", priority: "low",
          render: (user) => (user.whatsapp ? h("span", { class: "num small" }, user.whatsapp) : h("span", { class: "dim" }, "\u2014")) },
        { key: "pin_enabled", label: "PIN", priority: "low", render: (user) => (user.pin_enabled ? badge("Set", "success") : h("span", { class: "dim" }, "—")) },
        {
          key: "status", label: "Status",
          render: (user) => h("div", { class: "flex gap-1 wrap" },
            statusBadge(user.status),
            user.must_change_password ? badge("Temp password", "warning") : null),
        },
        { key: "last_login_at", label: "Last sign-in", priority: "mid", render: (user) => h("span", { class: "dim" }, user.last_login_at ? dateTime(user.last_login_at) : "Never") },
        {
          key: "actions", label: "", align: "right",
          render: (user) => h("div", { class: "table-actions" },
            iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(user, data.roles) }),
            user.is_developer ? null : iconButton("key", { size: "sm", variant: "ghost", title: "Reset password", onClick: async () => {
              const ok = await confirmDialog({
                title: `Reset the password for ${user.full_name}?`,
                message: "We generate a new temporary password. They choose their own the next time they sign in.",
                confirmLabel: "Reset password",
              });
              if (!ok) return;
              try {
                const result = await post(`/company/users/${user.id}/reset-password`);
                revealTemporaryPassword(result.item, result.temporary_password, { reset: true });
                load();
              } catch (error) {
                toast(error.message, "error");
              }
            } }),
            iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Remove", onClick: async () => {
              const ok = await confirmDialog({ title: `Remove ${user.full_name}?`, message: "Their sales history stays in reports.", confirmLabel: "Remove", danger: true });
              if (!ok) return;
              try {
                await del(`/company/users/${user.id}`);
                toast("Teammate removed.", "success");
                load();
              } catch (error) {
                toast(error.message, "error");
              }
            } })),
        },
      ],
    }));
  }

  /* Show the one-time password once, with a copy button: it is never readable again. */
  function revealTemporaryPassword(user, temporaryPassword, { reset = false } = {}) {
    let instance;
    const copy = button("Copy", { icon: "copy", size: "sm", onClick: async () => {
      try {
        await navigator.clipboard.writeText(temporaryPassword);
        toast("Password copied.", "success");
      } catch {
        toast("Select the password and copy it manually.", "warning");
      }
    } });
    instance = modal({
      title: reset ? "New temporary password" : "Teammate added",
      subtitle: `${user.full_name} · ${user.email}`,
      size: "sm",
      body: h("div", { class: "col gap-3" },
        h("div", { class: "temp-pass" },
          h("span", { class: "temp-pass__value mono" }, temporaryPassword),
          copy),
        alertBox("Share this once with your teammate. They will be asked to choose their own password the first time they sign in.", "info")),
      footer: [button("Done", { variant: "primary", onClick: () => instance.close() })],
    });
  }

  function openForm(user, roles) {
    const isEdit = Boolean(user);
    const fullName = textInput({ value: user?.full_name || "", placeholder: "Full name" });
    const email = textInput({ type: "email", value: user?.email || "", placeholder: "name@company.com" });
    const phone = textInput({ value: user?.phone || "", placeholder: "Phone" });
    const whatsapp = textInput({
      value: user?.whatsapp || "",
      placeholder: "+263 77 123 4567",
      attrs: { inputmode: "tel" },
    });
    const role = select({ value: user?.role_id || roles[0]?.id, options: roles.map((entry) => ({ value: entry.id, label: entry.name })) });
    const password = textInput({ type: "password", placeholder: "Leave blank to keep the temporary password" });
    const pin = textInput({ value: "", placeholder: "4-digit terminal PIN", maxlength: 12 });
    const status = select({
      value: user?.status || "active",
      options: [{ value: "active", label: "Active" }, { value: "invited", label: "Invited" }, { value: "disabled", label: "Disabled" }],
    });
    const errorHost = h("div");
    const instance = modal({
      title: isEdit ? `Edit ${user.full_name}` : "Add a teammate",
      subtitle: isEdit ? null : "We generate a temporary password for them",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Full name", control: fullName, required: true }),
        field({ label: "Email", control: email, required: !isEdit,
          hint: "One account per email - we check before saving." }),
        formGrid([
          field({ label: "Phone", control: phone }),
          field({ label: "WhatsApp", control: whatsapp, required: !isEdit,
            hint: "Used for the 6pm executive summary." }),
        ]),
        formGrid([field({ label: "Role", control: role }), field({ label: "Status", control: status })]),
        isEdit
          ? field({ label: "Password", control: password, hint: "Leave blank to keep theirs. Anything you set here must be changed at their next sign-in." })
          : null,
        field({ label: "Terminal PIN", control: pin, hint: "Used for quick cashier switching." })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(isEdit ? "Save changes" : "Add teammate", { variant: "primary", onClick: async () => {
        const payload = {
          full_name: fullName.value.trim(),
          email: email.value.trim(),
          phone: phone.value.trim(),
          whatsapp: whatsapp.value.trim(),
          role_id: Number(role.value),
          status: status.value,
        };
        if (password.value) payload.password = password.value;
        if (pin.value) payload.pin = pin.value;
        try {
          if (isEdit) {
            await patch(`/company/users/${user.id}`, payload);
            toast("Team updated.", "success");
            instance.close();
          } else {
            const result = await post("/company/users", payload);
            instance.close();
            revealTemporaryPassword(result.item, result.temporary_password);
          }
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(
            error.fields && Object.keys(error.fields).length
              ? `${error.message} ${Object.values(error.fields).join(" ")}`
              : error.message, "danger"));
        }
      } })],
    });
  }

  const addButton = button("Add teammate", { variant: "primary", icon: "plus", onClick: async () => {
    const data = await get("/company/users");
    openForm(null, data.roles);
  } });

  host.appendChild(card("Team", "Everyone who signs in to this workspace",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-end" }, addButton),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Report recipients                                                          */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.reports = async (host) => {
  const listHost = h("div");
  let teammates = [];

  async function load() {
    clear(listHost);
    const data = await get("/company/report-recipients");
    teammates = data.teammates || [];
    const wa = data.whatsapp || {};
    const connection = h("div", { class: "flex items-center gap-2 wrap" },
      badge(wa.configured ? "WhatsApp connected" : "WhatsApp not connected", wa.configured ? "success" : "warning"),
      h("span", { class: "tiny dim" },
        wa.configured
          ? `Sending from ${wa.business_number || "your business number"}.`
          : "Add WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN to the server environment."));
    const last = data.last_dispatch;
    const lastLine = last
      ? h("div", { class: "tiny dim" },
        `Last delivery ${last.report_date}: ${last.status}`
        + (last.delivered_count !== undefined ? ` · ${last.delivered_count} of ${last.recipient_count} delivered` : ""))
      : h("div", { class: "tiny dim" }, "No delivery has run yet.");

    listHost.appendChild(h("div", { class: "col gap-2" },
      h("div", { class: "flex items-center justify-between gap-2 wrap" },
        connection,
        h("div", { class: "flex gap-2" },
          button("Preview today's report", { size: "sm", icon: "eye", onClick: preview }),
          button("Send now", { size: "sm", variant: "primary", icon: "whatsapp", onClick: sendNow }),
          button("Add recipient", { size: "sm", variant: "primary", icon: "plus", onClick: () => openForm(null) }))),
      lastLine));

    listHost.appendChild(table({
      rows: data.items,
      empty: {
        icon: "whatsapp",
        title: "No report recipients yet",
        text: "Add a teammate with a WhatsApp number, then pick them here to receive the 6pm summary.",
      },
      columns: [
        {
          key: "name", label: "Recipient",
          render: (row) => h("div", { class: "flex items-center gap-2" },
            avatar(row.name, "#0f9d58", "sm"),
            h("div", {},
              h("div", { class: "strong" }, row.name),
              h("div", { class: "tiny dim" },
                [row.role_label, row.email].filter(Boolean).join(" · ") || "WhatsApp only"))),
        },
        { key: "whatsapp_number", label: "WhatsApp", render: (row) => h("span", { class: "num small" }, row.whatsapp_number) },
        {
          key: "is_active", label: "Status",
          render: (row) => (row.is_active ? badge("Receiving", "success") : badge("Paused", "warning")),
        },
        {
          key: "last_sent_at", label: "Last report",
          render: (row) => h("div", { class: "tiny" },
            row.last_sent_at ? dateTime(row.last_sent_at) : h("span", { class: "dim" }, "Never"),
            row.last_status ? h("div", { class: "tiny dim" }, row.last_status) : null),
        },
        {
          key: "actions", label: "", align: "right",
          render: (row) => h("div", { class: "table-actions" },
            iconButton("whatsapp", {
              size: "sm", variant: "ghost", title: "Send a test message",
              onClick: async () => {
                try {
                  await post(`/company/report-recipients/${row.id}/test`, {});
                  toast(`Test message sent to ${row.name}.`, "success");
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }),
            iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(row) }),
            iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Remove", onClick: async () => {
              const ok = await confirmDialog({
                title: `Stop reports to ${row.name}?`,
                message: "They will no longer receive the daily executive summary.",
                confirmLabel: "Remove",
                danger: true,
              });
              if (!ok) return;
              try {
                await del(`/company/report-recipients/${row.id}`);
                toast("Recipient removed.", "success");
                load();
              } catch (error) {
                toast(error.message, "error");
              }
            } })),
        },
      ],
    }));
  }

  function openForm(row) {
    const isEdit = Boolean(row);
    const status = select({
      value: row && row.is_active === false ? "paused" : "active",
      options: [{ value: "active", label: "Receiving reports" }, { value: "paused", label: "Paused" }],
    });
    const roleLabel = textInput({ value: row?.role_label || "", placeholder: "Owner, manager, accountant\u2026" });
    const errorHost = h("div");

    if (isEdit) {
      const instance = modal({
        title: `Reports for ${row.name}`,
        subtitle: "The name and number come from their teammate record",
        size: "sm",
        body: h("div", { class: "col gap-3" }, errorHost,
          alertBox("Edit the teammate to change their WhatsApp number \u2014 reports always follow the team record.", "info"),
          formGrid([
            field({ label: "Role / label", control: roleLabel }),
            field({ label: "Status", control: status }),
          ])),
        footer: [button("Cancel", { onClick: () => instance.close() }), button("Save changes", {
          variant: "primary",
          onClick: async () => {
            try {
              await patch(`/company/report-recipients/${row.id}`, {
                role_label: roleLabel.value.trim(),
                is_active: status.value === "active",
              });
              toast("Recipient updated.", "success");
              instance.close();
              load();
            } catch (error) {
              clear(errorHost);
              errorHost.appendChild(alertBox(error.message, "danger"));
            }
          },
        })],
      });
      return;
    }

    const picker = select({
      value: "",
      options: [{ value: "", label: "Choose a teammate\u2026" },
        ...(teammates || []).map((mate) => ({ value: mate.id, label: `${mate.name} \u00b7 ${mate.whatsapp}` }))],
    });
    const instance = modal({
      title: "Add a report recipient",
      subtitle: "Only teammates can receive reports \u2014 their WhatsApp number is already on file",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        teammates && teammates.length
          ? null
          : alertBox("Every teammate with a WhatsApp number is already receiving reports. Add a teammate first, with their WhatsApp number.", "warning"),
        field({ label: "Teammate", control: picker, required: true }),
        field({ label: "Role / label (optional)", control: roleLabel, hint: "Defaults to their workspace role." })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button("Add recipient", {
        variant: "primary", icon: "plus", disabled: !(teammates || []).length,
        onClick: async () => {
          if (!picker.value) {
            errorHost.appendChild(alertBox("Choose the teammate who should receive the 6pm summary.", "danger"));
            return;
          }
          try {
            await post("/company/report-recipients", {
              user_id: Number(picker.value),
              role_label: roleLabel.value.trim(),
              is_active: true,
            });
            toast("Recipient added.", "success");
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

  async function preview() {
    try {
      const data = await get("/company/report-recipients/preview");
      const instance = modal({
        title: "Today's executive summary",
        subtitle: `Preview · ${data.local_date || "today"} · 6pm local time`,
        size: "md",
        body: h("div", { class: "col gap-3" },
          h("pre", { class: "report-preview" }, data.text),
          data.whatsapp && !data.whatsapp.configured
            ? alertBox("WhatsApp is not connected yet. Add the environment variables on Render before sending.", "warning")
            : null),
        footer: [button("Close", { onClick: () => instance.close() })],
      });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function sendNow() {
    const ok = await confirmDialog({
      title: "Send today's report now?",
      message: "This sends the executive summary to every active recipient immediately. Today's scheduled 6pm run will be marked as already sent.",
      confirmLabel: "Send now",
    });
    if (!ok) return;
    try {
      const result = await post("/company/report-recipients/send-now", { force: true });
      if (result.status === "skipped") {
        toast(result.reason || "Add a report recipient first.", "warning");
      } else if (result.status === "not_configured") {
        toast("WhatsApp is not connected yet. Add the environment variables on Render.", "warning");
      } else if (result.status === "failed" || result.status === "partial") {
        toast(`Report finished with ${result.failed || 0} failed delivery${result.failed === 1 ? "" : "ies"}. Check the recipient number.`, "warning");
      } else {
        toast(`Report sent to ${result.delivered || 0} recipient${result.delivered === 1 ? "" : "s"}.`, "success");
      }
      load();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  host.appendChild(card(
    "Report recipients",
    "The executive summary is delivered every day at 6pm company time — sales, profit, week and month trends, and management advice.",
    listHost,
  ));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Roles & permissions                                                        */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.roles = async (host) => {
  const listHost = h("div");
  let permissions = [];

  async function load() {
    clear(listHost);
    const data = await get("/company/roles");
    permissions = data.permissions;
    for (const role of data.items) {
      listHost.appendChild(h("div", { class: "card card--pad mb-2" },
        h("div", { class: "flex items-start gap-2" },
          h("div", { class: "module-card__icon" }, icon("shield")),
          h("div", { class: "grow" },
            h("div", { class: "strong" }, role.name, role.is_system ? badge("System", "primary") : null),
            h("div", { class: "tiny dim" }, `${role.user_count} staff · ${role.permissions.length} permissions`)),
          role.name === "Administrator" ? badge("All access", "success") : button("Edit", { size: "sm", icon: "edit", onClick: () => openForm(role) }),
          role.is_system ? null : iconButton("trash", { size: "sm", variant: "ghost", danger: true, title: "Delete", onClick: async () => {
            const ok = await confirmDialog({ title: `Delete ${role.name}?`, message: "Move staff out of this role first.", confirmLabel: "Delete", danger: true });
            if (!ok) return;
            try {
              await del(`/company/roles/${role.id}`);
              toast("Role deleted.", "success");
              load();
            } catch (error) {
              toast(error.message, "error");
            }
          } })),
        h("div", { class: "chips mt-2" },
          role.permissions.slice(0, 8).map((permission) => badge(permission.replace(".", " · "), "outline")),
          role.permissions.length > 8 ? badge(`+${role.permissions.length - 8} more`) : null)));
    }
  }

  function openForm(role = null) {
    const name = textInput({ value: role?.name || "", placeholder: "e.g. Shift supervisor" });
    const description = textInput({ value: role?.description || "", placeholder: "What can this role do?" });
    const selected = new Set(role ? role.permissions : ["pos.sell"]);
    const groups = {};
    for (const permission of permissions) {
      groups[permission.group] = groups[permission.group] || [];
      groups[permission.group].push(permission);
    }
    const checks = h("div", { class: "col gap-2" });
    for (const [group, entries] of Object.entries(groups)) {
      checks.appendChild(row(group));
      for (const permission of entries) {
        const checkbox = h("input", { type: "checkbox", checked: selected.has(permission.key) });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(permission.key);
          else selected.delete(permission.key);
        });
        checks.appendChild(h("label", { class: "checkbox" }, checkbox,
          h("span", {}, h("span", { class: "strong small" }, permission.label),
            h("span", { class: "tiny dim" }, ` · ${permission.key}`))));
      }
    }
    const errorHost = h("div");
    const instance = modal({
      title: role ? `Edit ${role.name}` : "New role",
      subtitle: "Pick exactly what this role can do",
      size: "md",
      body: h("div", { class: "col gap-3" }, errorHost,
        formGrid([field({ label: "Name", control: name, required: true }), field({ label: "Description", control: description })]),
        checks),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(role ? "Save role" : "Create role", { variant: "primary", onClick: async () => {
        try {
          const payload = { name: name.value.trim(), description: description.value.trim(), permissions: [...selected] };
          if (role) await patch(`/company/roles/${role.id}`, payload);
          else await post("/company/roles", payload);
          toast("Role saved.", "success");
          instance.close();
          await refreshSession();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
        }
      } })],
    });
  }

  host.appendChild(card("Roles & permissions", "Granular control over who can do what",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-end" }, button("New role", { variant: "primary", icon: "plus", onClick: () => openForm() })),
      listHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.audit = async (host) => {
  const tableHost = h("div");
  const filters = { q: "", page: 1 };
  const search = searchLoader(textInput({ placeholder: "Search actions, people or notes…", className: "input--sm" }));
  search.addEventListener("input", debounce(() => { filters.q = search.value.trim(); filters.page = 1; load(); }, 250));

  async function load() {
    clear(tableHost);
    tableHost.appendChild(h("div", { class: "loading-block" }, h("div", { class: "spinner" })));
    try {
      const data = await get("/company/audit", { q: filters.q, page: filters.page, per_page: 40 });
      clear(tableHost);
      tableHost.appendChild(table({
        rows: data.items,
        empty: { icon: "list", title: "No activity yet", text: "Actions across the workspace show up here." },
        columns: [
          { key: "created_at", label: "When", render: (item) => h("span", { class: "dim tiny" }, dateTime(item.created_at)) },
          { key: "action", label: "Action", render: (item) => h("span", { class: "mono small" }, item.action) },
          { key: "summary", label: "Detail", render: (item) => h("span", { class: "small" }, item.summary || "—") },
          { key: "actor", label: "By", render: (item) => h("div", {}, h("div", { class: "small" }, item.actor), h("div", { class: "tiny dim" }, item.ip || "")) },
        ],
      }));
      tableHost.appendChild(pagination(data.meta, (page) => { filters.page = page; load(); }));
    } catch (error) {
      clear(tableHost);
      tableHost.appendChild(alertBox(error.message, "danger"));
    }
  }

  host.appendChild(card("Activity log", "An immutable trail of important actions",
    h("div", { class: "col gap-3" },
      h("div", { style: { width: "280px" } }, search),
      tableHost)));
  await load();
};

/* ------------------------------------------------------------------------- */
/* Danger zone                                                                */
/* ------------------------------------------------------------------------- */
SECTION_RENDERERS.danger = async (host) => {
  host.appendChild(card("Reset a settings section", "Restore the defaults for one area without touching your data",
    h("div", { class: "grid grid--3" },
      ["branding", "currency", "business", "receipts", "dashboard", "sales"].map((sectionName) =>
        button(`Reset ${sectionName}`, {
          icon: "rotate",
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Reset ${sectionName}?`,
              message: "This restores the default values for that section. Products, sales and staff are not affected.",
              confirmLabel: "Reset",
              danger: true,
            });
            if (!ok) return;
            try {
              await post("/company/reset-settings", { section: sectionName });
              await refreshSession();
              toast(`${sectionName} reset.`, "success");
            } catch (error) {
              toast(error.message, "error");
            }
          },
        })))));

  host.appendChild(card("Delete this workspace", "Only platform staff can delete a company and its data",
    h("div", { class: "alert alert--danger" },
      icon("warn"),
      h("div", { class: "grow" },
        h("div", { class: "strong" }, "Deletion is permanent"),
        h("div", { class: "small" }, "Contact platform support to archive or erase this workspace. Every sale, product and staff record will be removed.")))));
};
