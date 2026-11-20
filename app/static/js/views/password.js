/* Password flows: the first-run gate a temporary-password account must clear,
   and the change-password dialog used from the user menus. */

import { h, clear } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { post } from "../core/http.js";
import { store, getSession, currentCompany, currentUser, wordmark } from "../core/store.js";
import { alertBox, button, field, modal, passwordField, textInput, toast } from "../core/ui.js";

const MIN_LENGTH = 8;

function validate(next, confirm) {
  if (next.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (next !== confirm) return "The two passwords do not match.";
  return "";
}

function passwordPoints() {
  return h("div", { class: "auth__points" },
    point("key", "Only you know it", "Nobody on the team — not even an admin — can read the password you pick."),
    point("shield", "The temporary one stops working", "It is replaced the moment you save, on every device."),
    point("bolt", "Nothing else changes", "Your till, reports and permissions stay exactly as they are."));
}

function point(iconName, title, text) {
  return h("div", { class: "auth__point" },
    icon(iconName),
    h("div", {},
      h("div", { style: { fontWeight: "620", color: "#fff" } }, title),
      h("div", { class: "small", style: { color: "rgba(255,255,255,.62)", marginTop: "2px" } }, text)));
}

/* Replaces the whole shell: an account with a temporary password cannot reach
   any other screen until it has chosen its own. */
export default function passwordGate({ user, onDone, onSignOut } = {}) {
  const company = currentCompany();
  const branding = company?.settings?.branding || {};
  const name = wordmark(company) || "Universal POS";

  const next = textInput({
    type: "password", placeholder: "At least 8 characters", id: "first-run-password",
    attrs: { autocomplete: "new-password" },
  });
  const confirm = textInput({
    type: "password", placeholder: "Type it again", id: "first-run-confirm",
    attrs: { autocomplete: "new-password" },
  });
  const errors = h("div");
  const submit = button("Save and continue", { variant: "primary", size: "lg", block: true, type: "submit" });

  const form = h("form", {
    class: "col gap-4",
    onSubmit: async (event) => {
      event.preventDefault();
      clear(errors);
      const problem = validate(next.value, confirm.value);
      if (problem) {
        errors.appendChild(alertBox(problem, "danger"));
        (problem.startsWith("The two") ? confirm : next).focus();
        return;
      }
      submit.setLoading(true);
      try {
        const data = await post("/auth/password", { new_password: next.value });
        if (data?.item?.must_change_password !== false) {
          throw new Error("The password could not be saved. Try again.");
        }
        onDone?.(data.item);
      } catch (error) {
        errors.appendChild(alertBox(error.message, "danger"));
        submit.setLoading(false);
      }
    },
  },
  errors,
  field({ label: "New password", control: passwordField(next), required: true, hint: "At least 8 characters. Avoid your name or the temporary one." }),
  field({ label: "Confirm password", control: passwordField(confirm), required: true }),
  submit);

  const el = h("div", { class: "auth auth--gate" },
    h("div", { class: "auth__art" },
      h("div", { class: "auth__brand" },
        h("div", { class: "brand__mark" }, branding.logo_data_url
          ? h("img", { src: branding.logo_data_url, alt: name })
          : icon("sparkles")),
        h("div", {},
          h("div", { style: { fontWeight: "700", letterSpacing: "-.02em" } }, name),
          h("div", { class: "tiny", style: { color: "rgba(255,255,255,.6)" } }, "One last step before you start"))),
      h("h1", { class: "auth__headline" }, "Make this account yours."),
      h("p", { class: "auth__lead" },
        "You signed in with a temporary password. Choose one only you know and the app unlocks — your till, reports and permissions are already set up."),
      passwordPoints()),
    h("div", { class: "auth__panel" },
      h("div", { class: "auth__card" },
        h("h2", { class: "auth__title" }, "Choose your password"),
        h("p", { class: "auth__sub" }, user?.email
          ? `Signed in as ${user.full_name || "you"} · ${user.email}`
          : "Set the password you will use from now on."),
        h("div", { class: "auth__tabs" }),
        form,
        h("div", { class: "auth__trust", style: { "margin-top": "16px" } },
          h("span", {}, icon("lock"), "Encrypted · stored only as a hash")),
        h("div", { style: { "margin-top": "14px" } },
          button("Sign out instead", { variant: "ghost", block: true, onClick: () => onSignOut?.() })))));

  setTimeout(() => next.focus(), 60);
  return el;
}

/* Ordinary password change, for a signed-in teammate or owner. */
export function openPasswordDialog({ onDone } = {}) {
  const current = textInput({
    type: "password", placeholder: "Current password", id: "change-current-password",
    attrs: { autocomplete: "current-password" },
  });
  const next = textInput({
    type: "password", placeholder: "At least 8 characters", id: "change-new-password",
    attrs: { autocomplete: "new-password" },
  });
  const confirm = textInput({
    type: "password", placeholder: "Type it again", id: "change-confirm-password",
    attrs: { autocomplete: "new-password" },
  });
  const errors = h("div");
  const save = button("Update password", { variant: "primary", onClick: () => submit() });

  const instance = modal({
    title: "Change your password",
    subtitle: currentUser()?.must_change_password
      ? "Your temporary password has done its job — choose the one you will keep."
      : "Use it the next time you sign in, on any device.",
    size: "sm",
    body: h("div", { class: "col gap-3" },
      errors,
      field({ label: "Current password", control: passwordField(current) }),
      field({ label: "New password", control: passwordField(next), hint: "At least 8 characters, different from the old one." }),
      field({ label: "Confirm new password", control: passwordField(confirm) })),
    footer: [button("Cancel", { onClick: () => instance.close() }), save],
  });

  async function submit() {
    clear(errors);
    const problem = validate(next.value, confirm.value);
    if (problem) {
      errors.appendChild(alertBox(problem, "danger"));
      return;
    }
    save.setLoading(true);
    try {
      const data = await post("/auth/password", {
        current_password: current.value,
        new_password: next.value,
      });
      const session = getSession();
      if (session?.user && data?.item) {
        store.set({ session: { ...session, user: { ...session.user, ...data.item } } });
      }
      instance.close();
      toast("Password updated. Use it the next time you sign in.", "success");
      onDone?.(data?.item);
    } catch (error) {
      errors.appendChild(alertBox(error.message, "danger"));
      save.setLoading(false);
    }
  }

  setTimeout(() => next.focus(), 60);
  return instance;
}
