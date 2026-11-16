/* All workspace settings sections. */

import { h, clear, debounce } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { money, number, date, dateTime, isoDay } from "../core/fmt.js";
import { get, post, patch, del } from "../core/http.js";
import {
  store, getSession, companyName, currentCompany, hasAny, moduleOn, moduleConfig, settings, applyBranding,
} from "../core/store.js";
import {
  sectionCard, button, iconButton, table, badge, toast, alertBox, field, textInput, textarea, select,
  switchControl, switchRow, modal, confirmDialog, formGrid, moneyInput, tagInput, emptyState, statusBadge,
  avatar, pagination, kvList, segmented,
} from "../core/ui.js";

export const SECTION_RENDERERS = {};

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */
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
        field({ label: "Phone", control: phone }),
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
  const showImages = switchControl({ checked: cfg.show_images !== false, label: "Show product emoji/images" });
  const showStock = switchControl({ checked: cfg.show_stock !== false, label: "Show stock counts on tiles" });
  const autoPrint = switchControl({ checked: Boolean(cfg.auto_print), label: "Print receipts automatically" });
  const sound = switchControl({ checked: cfg.sound_enabled !== false, label: "Play a sound when adding items" });
  const customerRequired = switchControl({ checked: Boolean(cfg.customer_required), label: "Require a customer on every sale" });

  const tipsOn = switchControl({ checked: moduleOn("tips"), label: "" });
  const notesOn = switchControl({ checked: moduleOn("order_notes"), label: "" });
  const roundingOn = switchControl({ checked: moduleOn("rounding"), label: "" });
  const serviceOn = switchControl({ checked: moduleOn("service_charge"), label: "" });
  const holdersOn = switchControl({ checked: moduleOn("holders"), label: "" });
  const overridesOn = switchControl({ checked: moduleOn("price_overrides"), label: "" });
  const laybyOn = switchControl({ checked: moduleOn("layby"), label: "" });

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

  host.appendChild(card("Checkout extras", "Toggle the modules that change how a sale completes",
    h("div", { class: "col" },
      switchRow({ title: "Tips", hint: "Let customers add a tip by percentage or amount.", checked: tipsOn.input.checked, onChange: (v) => { tipsOn.input.checked = v; } }),
      switchRow({ title: "Item notes", hint: "Kitchen notes, gift wrap, special requests.", checked: notesOn.input.checked, onChange: (v) => { notesOn.input.checked = v; } }),
      switchRow({ title: "Cash rounding", hint: "Round the total to the nearest increment.", checked: roundingOn.input.checked, onChange: (v) => { roundingOn.input.checked = v; } }),
      switchRow({ title: "Service charge", hint: "Automatically add a percentage to each ticket.", checked: serviceOn.input.checked, onChange: (v) => { serviceOn.input.checked = v; } }),
      switchRow({ title: "Held orders", hint: "Park a cart and resume it later.", checked: holdersOn.input.checked, onChange: (v) => { holdersOn.input.checked = v; } }),
      switchRow({ title: "Price overrides", hint: "Allow trusted staff to edit a line price.", checked: overridesOn.input.checked, onChange: (v) => { overridesOn.input.checked = v; } }),
      switchRow({ title: "Lay-by", hint: "Reserve goods on a deposit and collect instalments.", checked: laybyOn.input.checked, onChange: (v) => { laybyOn.input.checked = v; } }),
      h("div", { class: "flex justify-end mt-3" }, saveButton("Apply extras", async () => {
        await saveModule("tips", { enabled: tipsOn.input.checked }, "");
        await saveModule("order_notes", { enabled: notesOn.input.checked }, "");
        await saveModule("rounding", { enabled: roundingOn.input.checked }, "");
        await saveModule("service_charge", { enabled: serviceOn.input.checked }, "");
        await saveModule("holders", { enabled: holdersOn.input.checked }, "");
        await saveModule("price_overrides", { enabled: overridesOn.input.checked }, "");
        await saveModule("layby", { enabled: laybyOn.input.checked }, "");
        toast("Checkout extras updated.", "success");
      })))));
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
            module.locked
              ? badge("Always on", "success")
              : switchControl({
                checked: current.enabled,
                onChange: async (value) => {
                  try {
                    await patch(`/company/modules/${module.key}`, { enabled: value });
                    await refreshSession();
                    cardEl.classList.toggle("is-on", value);
                    toast(`${module.name} ${value ? "enabled" : "disabled"}.`, "success");
                  } catch (error) {
                    toast(error.message, "error");
                  }
                },
              })));
        grid.appendChild(cardEl);
      }
    }
  }

  search.addEventListener("input", () => renderGrid(search.value.toLowerCase().trim()));
  const enabledCount = Object.values(state).filter((entry) => entry.enabled).length;
  host.appendChild(card("Modules", "Compose the POS you need — switch features on, then tune them",
    h("div", { class: "col gap-3" },
      h("div", { class: "flex justify-between items-center gap-2 wrap" },
        badge(`${enabledCount} of ${catalog.length} enabled`, "primary"),
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
        field({ label: "Phone", control: phone }),
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
        { key: "pin_enabled", label: "PIN", render: (user) => (user.pin_enabled ? badge("Set", "success") : h("span", { class: "dim" }, "—")) },
        { key: "status", label: "Status", render: (user) => statusBadge(user.status) },
        { key: "last_login_at", label: "Last sign-in", render: (user) => h("span", { class: "dim" }, user.last_login_at ? dateTime(user.last_login_at) : "Never") },
        {
          key: "actions", label: "", align: "right",
          render: (user) => h("div", { class: "table-actions" },
            iconButton("edit", { size: "sm", variant: "ghost", title: "Edit", onClick: () => openForm(user, data.roles) }),
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

  function openForm(user, roles) {
    const isEdit = Boolean(user);
    const fullName = textInput({ value: user?.full_name || "", placeholder: "Full name" });
    const email = textInput({ type: "email", value: user?.email || "", placeholder: "name@company.com" });
    const phone = textInput({ value: user?.phone || "", placeholder: "Phone" });
    const role = select({ value: user?.role_id || roles[0]?.id, options: roles.map((entry) => ({ value: entry.id, label: entry.name })) });
    const password = textInput({ type: "password", placeholder: isEdit ? "Leave blank to keep current" : "At least 8 characters" });
    const pin = textInput({ value: "", placeholder: "4-digit terminal PIN", maxlength: 12 });
    const status = select({
      value: user?.status || "active",
      options: [{ value: "active", label: "Active" }, { value: "invited", label: "Invited" }, { value: "disabled", label: "Disabled" }],
    });
    const errorHost = h("div");
    const instance = modal({
      title: isEdit ? `Edit ${user.full_name}` : "Add a teammate",
      size: "sm",
      body: h("div", { class: "col gap-3" }, errorHost,
        field({ label: "Full name", control: fullName, required: true }),
        field({ label: "Email", control: email, required: !isEdit }),
        field({ label: "Phone", control: phone }),
        formGrid([field({ label: "Role", control: role }), field({ label: "Status", control: status })]),
        field({ label: "Password", control: password, required: !isEdit }),
        field({ label: "Terminal PIN", control: pin, hint: "Used for quick cashier switching." })),
      footer: [button("Cancel", { onClick: () => instance.close() }), button(isEdit ? "Save changes" : "Add teammate", { variant: "primary", onClick: async () => {
        const payload = {
          full_name: fullName.value.trim(),
          email: email.value.trim(),
          phone: phone.value.trim(),
          role_id: Number(role.value),
          status: status.value,
        };
        if (password.value) payload.password = password.value;
        if (pin.value) payload.pin = pin.value;
        try {
          if (isEdit) await patch(`/company/users/${user.id}`, payload);
          else await post("/company/users", payload);
          toast("Team updated.", "success");
          instance.close();
          load();
        } catch (error) {
          clear(errorHost);
          errorHost.appendChild(alertBox(error.message, "danger"));
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
  const search = textInput({ placeholder: "Search actions, people or notes…", className: "input--sm" });
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
