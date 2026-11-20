/* The offline pill and the "push to cloud" prompt.

   Sits above every screen: while anything is queued it shows how many changes are
   waiting and, the moment the connection returns, offers to push them. */

import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { isAuthed } from "./store.js";
import { enqueueWrite, outboxCount, outboxItems, pushOutbox, isBrowserOffline } from "./offline.js";
import { button, modal, toast } from "./ui.js";

let mounted = false;
let bar = null;
let prompting = false;

function stamp(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render() {
  if (!bar) return;
  const count = outboxCount();
  const signedIn = isAuthed();
  bar.classList.toggle("is-on", signedIn && count > 0);
  if (!signedIn || !count) {
    clear(bar);
    return;
  }
  const online = !isBrowserOffline();
  clear(bar);
  bar.appendChild(h("div", { class: "outbox-bar__icon" }, icon(online ? "upload" : "clock")));
  bar.appendChild(h("div", { class: "outbox-bar__text" },
    h("strong", {}, `${count} change${count === 1 ? "" : "s"} waiting`),
    h("span", {}, online ? "Saved on this device — push them to the cloud." : "Offline — they are safe on this device.")));
  bar.appendChild(button(online ? "Push now" : "Offline", {
    size: "sm",
    variant: online ? "primary" : "",
    disabled: !online,
    onClick: () => pushAll(),
  }));
}

async function pushAll(instance) {
  const items = outboxItems();
  if (!items.length) {
    instance?.close();
    return;
  }
  const results = await pushOutbox();
  instance?.close();
  if (results.pushed && !results.failed) {
    toast(`${results.pushed} change${results.pushed === 1 ? "" : "s"} pushed to the cloud.`, "success", "Synced");
  } else if (results.pushed && results.failed) {
    toast(`${results.pushed} pushed · ${results.failed} need attention.`, "warning", "Partly synced");
  } else if (results.failed) {
    toast("The server rejected these changes — check them one by one.", "warning", "Not synced");
  } else {
    toast("Still offline — nothing was pushed.", "warning", "No connection");
  }
  window.dispatchEvent(new CustomEvent("pos:outbox-flushed", { detail: results }));
}

export function promptPush() {
  if (prompting || !isAuthed() || isBrowserOffline()) return;
  const items = outboxItems();
  if (!items.length) return;
  prompting = true;
  const preview = items.slice(0, 4).map((item) => h("div", { class: "outbox-item" },
    h("span", { class: "outbox-item__label" }, item.label || item.path),
    h("span", { class: "outbox-item__time" }, stamp(item.queuedAt))));
  const instance = modal({
    title: "Back online",
    subtitle: `${items.length} change${items.length === 1 ? "" : "s"} made offline`,
    size: "sm",
    onClose: () => { prompting = false; },
    body: h("div", { class: "col gap-3" },
      h("div", { class: "small" },
        "Nothing was lost while you were offline. Push now and the cloud catches up in order."),
      h("div", { class: "outbox-list" }, preview,
        items.length > 4
          ? h("div", { class: "outbox-item outbox-item--more" }, `+ ${items.length - 4} more`)
          : null)),
    footer: [
      button("Later", { onClick: () => instance.close() }),
      button("Push to cloud", { variant: "primary", icon: "upload", onClick: () => pushAll(instance) }),
    ],
  });
  return instance;
}

/* Ask, then keep the write on this device. Returns true when it is queued. */
export async function offerOfflineSave({ path, method = "POST", body, label = "" }) {
  if (!isAuthed()) return false;
  const reference = `OFF-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const confirmed = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const instance = modal({
      title: "No connection",
      subtitle: "Keep working — this saves on this device",
      size: "sm",
      onClose: () => finish(false),
      body: h("div", { class: "col gap-3" },
        h("div", { class: "small" },
          "The cloud cannot be reached right now. Save this here and push it when the internet returns?"),
        h("div", { class: "outbox-offer" },
          h("span", {}, label || path),
          h("strong", { class: "mono" }, reference))),
      footer: [
        button("Cancel", { onClick: () => instance.close() }),
        button("Save offline", {
          variant: "primary",
          icon: "upload",
          onClick: () => {
            finish(true);
            instance.close();
          },
        }),
      ],
    });
  });
  if (!confirmed) return false;
  enqueueWrite({ path, method, body, label, reference });
  toast(`${reference} is saved on this device and will be pushed to the cloud.`, "warning", "Saved offline");
  return true;
}

export function refreshOfflineBar() {
  render();
}

export function mountOfflineUi() {
  if (mounted) return;
  mounted = true;
  bar = h("div", { class: "outbox-bar", attrs: { role: "status", "aria-live": "polite" } });
  document.body.appendChild(bar);
  render();
  window.addEventListener("pos:outbox-changed", render);
  window.addEventListener("pos:outbox-pushed", render);
  window.addEventListener("pos:signed-out", render);
  window.addEventListener("offline", render);
  window.addEventListener("online", () => {
    render();
    promptPush();
  });
}
