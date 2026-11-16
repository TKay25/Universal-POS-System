/* Sign in / create a company workspace. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { store, applyBranding } from "../core/store.js";
import { post } from "../core/http.js";
import { button, field, textInput, select, alertBox, segmented } from "../core/ui.js";

const CURRENCIES = [
  { value: "USD|$", label: "US Dollar ($)" },
  { value: "GBP|£", label: "British Pound (£)" },
  { value: "EUR|€", label: "Euro (€)" },
  { value: "ZAR|R", label: "South African Rand (R)" },
  { value: "NGN|₦", label: "Nigerian Naira (₦)" },
  { value: "KES|KSh", label: "Kenyan Shilling (KSh)" },
  { value: "INR|₹", label: "Indian Rupee (₹)" },
  { value: "AUD|A$", label: "Australian Dollar (A$)" },
  { value: "CAD|C$", label: "Canadian Dollar (C$)" },
  { value: "AED|AED", label: "UAE Dirham (AED)" },
];

function formGrid2(children) {
  return h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "14px" } }, children);
}

export default function loginView({ onAuthed, initialError = "" } = {}) {
  let mode = "signin";

  const errorHost = h("div");
  const formHost = h("div");
  const tabsHost = h("div", { class: "auth__tabs" });

  function showError(message) {
    clear(errorHost);
    if (message) errorHost.appendChild(alertBox(message, "danger"));
  }

  function renderTabs() {
    clear(tabsHost);
    tabsHost.appendChild(segmented(
      [
        { value: "signin", label: "Sign in" },
        { value: "register", label: "Create a workspace" },
      ],
      {
        value: mode,
        onChange: (value) => {
          mode = value;
          showError("");
          renderTabs();
          renderForm();
        },
      },
    ));
  }

  function renderForm() {
    clear(formHost);
    if (mode === "signin") formHost.appendChild(signInForm());
    else formHost.appendChild(registerForm());
  }

  function signInForm() {
    const email = textInput({ placeholder: "you@company.com", autofocus: true, attrs: { autocomplete: "email" } });
    const password = textInput({ type: "password", placeholder: "••••••••", attrs: { autocomplete: "current-password" } });
    const submit = button("Sign in", { variant: "primary", size: "lg", block: true, type: "submit" });

    const form = h("form", {
      class: "col gap-4",
      onSubmit: async (e) => {
        e.preventDefault();
        showError("");
        submit.setLoading(true);
        try {
          const session = await post("/auth/login", { email: email.value.trim(), password: password.value });
          store.set({ session, csrf: session.csrf_token });
          applyBranding();
          onAuthed();
        } catch (error) {
          showError(error.message);
          submit.setLoading(false);
        }
      },
    },
    field({ label: "Email", control: email }),
    field({ label: "Password", control: password }),
    submit);

    const demo = h("div", { class: "auth__demo" },
      h("div", { class: "tiny dim strong", style: { textTransform: "uppercase", letterSpacing: ".09em" } }, "Demo accounts"),
      demoRow("Platform developer", "developer@universalpos.dev", "DevAdmin!2024", { role: "Developer" }),
      demoRow("Coffee shop owner", "owner@aurora.test", "Owner!2024", { role: "Owner" }),
      demoRow("Coffee shop cashier", "cashier@aurora.test", "Cashier!2024", { role: "Cashier" }),
      demoRow("Electronics owner", "owner@nova.test", "Owner!2024", { role: "Owner" }));

    function demoRow(name, mail, pass, meta) {
      return h("div", { class: "auth__demo-row" },
        h("span", { class: "grow" }, h("strong", {}, name), " ", h("span", { class: "dim" }, meta.role)),
        h("code", {}, mail),
        button("Use", {
          size: "sm",
          variant: "soft",
          onClick: () => {
            email.value = mail;
            password.value = pass;
            email.dispatchEvent(new Event("input"));
          },
        }));
    }

    return h("div", {}, form, demo);
  }

  function registerForm() {
    const company = textInput({ placeholder: "e.g. Cedar Street Bakery", autofocus: true });
    const name = textInput({ placeholder: "Your full name", attrs: { autocomplete: "name" } });
    const email = textInput({ placeholder: "you@company.com", attrs: { autocomplete: "email" } });
    const password = textInput({ type: "password", placeholder: "At least 8 characters", attrs: { autocomplete: "new-password" } });
    const currency = select({ value: "USD|$", options: CURRENCIES });
    const vat = textInput({ placeholder: "VAT number (optional)", attrs: { maxlength: "60" } });
    const companyReg = textInput({ placeholder: "Company registration number (optional)", attrs: { maxlength: "60" } });

    const submit = button("Create my workspace", { variant: "primary", size: "lg", block: true, type: "submit" });

    const form = h("form", {
      class: "col gap-4",
      onSubmit: async (e) => {
        e.preventDefault();
        showError("");
        const [code, symbol] = currency.value.split("|");
        submit.setLoading(true);
        try {
          const session = await post("/auth/register", {
            company_name: company.value.trim(),
            full_name: name.value.trim(),
            email: email.value.trim(),
            password: password.value,
            currency_code: code,
            currency_symbol: symbol,
            vat_number: vat.value.trim(),
            company_reg_number: companyReg.value.trim(),
          });
          store.set({ session, csrf: session.csrf_token });
          applyBranding();
          onAuthed();
        } catch (error) {
          showError(error.fields && Object.keys(error.fields).length
            ? `${error.message} ${Object.values(error.fields).join(" ")}`
            : error.message);
          submit.setLoading(false);
        }
      },
    },
    field({ label: "Company name", control: company }),
    field({ label: "Your name", control: name }),
    field({ label: "Work email", control: email }),
    field({ label: "Password", control: password, hint: "Minimum 8 characters." }),
    field({ label: "Currency", control: currency, hint: "You can change this later in settings." }),
    formGrid2([
      field({ label: "VAT registration number", control: vat, hint: "For Zimbabwe, your ZIMRA VAT number" }),
      field({ label: "Company registration number", control: companyReg, hint: "Registrar of Companies number" }),
    ]),
    submit,
    h("p", { class: "tiny dim center" },
      "You become the workspace Administrator with full access. You will start on a 14-day trial with every module available."));

    return form;
  }

  renderTabs();
  renderForm();
  if (initialError) showError(initialError);

  return h("div", { class: "auth" },
    h("div", { class: "auth__art" },
      h("div", { class: "auth__brand" },
        h("div", { class: "brand__mark" }, icon("sparkles")),
        h("div", {},
          h("div", { style: { fontWeight: "700", letterSpacing: "-.02em" } }, "Universal POS"),
          h("div", { class: "tiny", style: { color: "rgba(255,255,255,.6)" } }, "Build the till your business actually needs"))),
      h("h1", { class: "auth__headline" }, "One POS. Every business. Your rules."),
      h("p", { class: "auth__lead" },
        "Start with a complete point of sale, then switch on the modules you need — inventory, loyalty, tips, multi-location, custom workspaces and more. Every screen, colour and receipt is yours to shape."),
      h("div", { class: "auth__points" },
        point("sparkles", "Compose your own POS", "Enable only the modules you sell with, and configure each one."),
        point("palette", "Brand every pixel", "Colours, logo, receipts and dashboards follow your brand."),
        point("shield", "Roles that fit your team", "Granular permissions for owners, managers and cashiers."),
        point("chart", "Reports that reconcile", "Tax, cash drawer, refunds and product performance in one place."))),
    h("div", { class: "auth__panel" },
      h("div", { class: "auth__card" },
        h("h2", { class: "auth__title" }, mode === "signin" ? "Welcome back" : "Launch your workspace"),
        h("p", { class: "auth__sub" }, mode === "signin"
          ? "Sign in to your workspace or the platform console."
          : "Create a company workspace and start selling in minutes."),
        tabsHost,
        errorHost,
        formHost)));
}

function point(iconName, title, text) {
  return h("div", { class: "auth__point" },
    icon(iconName),
    h("div", {}, h("div", { style: { fontWeight: "620", color: "#fff" } }, title),
      h("div", { class: "small", style: { color: "rgba(255,255,255,.62)", marginTop: "2px" } }, text)));
}
