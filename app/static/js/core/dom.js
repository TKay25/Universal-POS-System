/* Tiny declarative DOM builder — the "react-like" core of the app. */

const BOOL_PROPS = new Set(["disabled", "readOnly", "required", "autofocus", "multiple", "hidden"]);

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) {
        if (BOOL_PROPS.has(key)) el[key] = false;
        continue;
      }
      if (key === "class" || key === "className") el.className = value;
      else if (key === "style") {
        if (typeof value === "string") el.style.cssText = value;
        else for (const [prop, val] of Object.entries(value)) {
          if (val != null) el.style.setProperty(prop, val);
        }
      } else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "attrs") {
        for (const [name, val] of Object.entries(value)) {
          if (val === false || val == null) continue;
          el.setAttribute(name, val === true ? "" : val);
        }
      } else if (key === "html") el.innerHTML = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "value") el.value = value;
      else if (key === "checked") el.checked = !!value;
      else if (key === "selected") el.selected = !!value;
      else if (BOOL_PROPS.has(key)) el[key] = !!value;
      else if (key in el) {
        try { el[key] = value; } catch { el.setAttribute(key, value); }
      } else el.setAttribute(key, value);
    }
  }
  append(el, children);
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(host, ...children) {
  clear(host);
  append(host, children);
  return host;
}

export function replace(oldNode, ...children) {
  const holder = document.createElement("div");
  append(holder, children);
  if (oldNode && oldNode.parentNode) {
    const nodes = [...holder.childNodes];
    oldNode.replaceWith(...nodes);
    return nodes[0] || null;
  }
  return holder.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function on(target, event, selector, handler) {
  target.addEventListener(event, (e) => {
    const match = e.target.closest(selector);
    if (match && target.contains(match)) handler(e, match);
  });
}

export function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function fragmentFromHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function tick() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function scrollTop(node) {
  if (node) node.scrollTop = 0;
}
