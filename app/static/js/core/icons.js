/* Inline SVG icon set (24x24, stroke based). */

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.2l2.4 11.2h11.6l1.8-8H6"/>',
  box: '<path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5z"/><path d="M3 8.5 12 14l9-5.5"/><path d="M12 14v7"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c.6-3.4 3.1-5.4 6.2-5.4s5.6 2 6.2 5.4"/><path d="M16.5 5.6a3 3 0 0 1 0 5.6"/><path d="M18.4 14.4c1.7.7 2.8 2.4 3.1 5"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-5"/><path d="M13 16V7"/><path d="M18 16v-8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8.6 3H9a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a2 2 0 1 1 0 4z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  edit: '<path d="M12 20H4V4h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L10 16l-4 1 1-4z"/>',
  print: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 16h10v5H7z"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  tag: '<path d="M3 12.5V4h8.5L21 13.5 13.5 21z"/><circle cx="7.5" cy="8" r="1.3"/>',
  star: '<path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/>',
  shield: '<path d="M12 3 5 6v6c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
  sparkles: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"/><path d="M18.5 3v3M17 4.5h3"/><path d="M5 17v2.5M3.8 18.2h2.5"/>',
  map: '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  truck: '<path d="M3 6.5h10v10H3z"/><path d="M13 10h4l3 3v3.5h-7z"/><circle cx="7" cy="18.5" r="1.6"/><circle cx="17.5" cy="18.5" r="1.6"/>',
  wallet: '<rect x="2.5" y="6" width="19" height="13" rx="3"/><path d="M2.5 10h19"/><circle cx="17" cy="14.5" r="1.2"/>',
  percent: '<path d="m6 18 12-12"/><circle cx="7.5" cy="7.5" r="2.4"/><circle cx="16.5" cy="16.5" r="2.4"/>',
  coins: '<ellipse cx="9" cy="6.5" rx="5.5" ry="2.6"/><path d="M3.5 6.5v4c0 1.4 2.5 2.6 5.5 2.6s5.5-1.2 5.5-2.6v-4"/><path d="M3.5 10.5v4c0 1.4 2.5 2.6 5.5 2.6"/><path d="M14.5 11.5c2.8.2 5 1.3 5 2.6v3.4c0 1.4-2.5 2.6-5.5 2.6-2 0-3.7-.6-4.7-1.5"/>',
  printer: '<path d="M7 8V3h10v5"/><rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 16h10v5H7z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  download: '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/>',
  upload: '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 20h16"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  wrench: '<path d="M15.5 3.5a5 5 0 0 0-6.6 6.6L3.5 15.5a2.1 2.1 0 0 0 3 3l5.4-5.4a5 5 0 0 0 6.6-6.6l-3 3-2.8-.7-.7-2.8z"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  note: '<path d="M5 3.5h9L19 8v12.5H5z"/><path d="M14 3.5V8h5"/><path d="M8.5 12h7M8.5 15.5h5"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v9M13 6v12M16 6v9M20 6v12"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 7.6 4 4 0 0 1 19 10.7C19 15.6 12 20 12 20z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  more: '<circle cx="12" cy="5.5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18.5" r="1.3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1 1-1.1 1.8v.4"/><path d="M12 17.2h.01"/>',
  building: '<path d="M4 21V5.5L12 3l8 2.5V21"/><path d="M9 21v-5h6v5"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-3.8 3.9-6 7.5-6s6.7 2.2 7.5 6"/>',
  palette: '<path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-3.6 3.5H15a2 2 0 0 0-1.4 3.4A1.8 1.8 0 0 1 12 21z"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16" cy="9.5" r="1.1"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8-8"/><path d="m16 7 2.5 2.5"/><path d="m13.5 9.5 2 2"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.6-5.4L3 9"/><path d="M4 13a8 8 0 0 0 13.6 5.4L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  trend: '<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15.5 6H21v5.5"/>',
  wallet2: '<path d="M4 7.5C4 5.6 5.6 4 7.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 8h16"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.4"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.8h.01"/>',
  warn: '<path d="M12 3.5 2.8 20h18.4z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2 2 0 0 0-2 2v9"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10"/>',
  gift: '<rect x="3.5" y="9" width="17" height="11.5" rx="2"/><path d="M3.5 13.5h17M12 9v11.5"/><path d="M12 9c-2.5 0-4.5-1.2-4.5-3S9 3 10.5 3.8 12 9 12 9s.4-4.4 1.9-5.2S18 3.2 18 5s-2 4-6 4z"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
  pin: '<path d="M12 21s6-5 6-9.5A6 6 0 1 0 6 11.5C6 16 12 21 12 21z"/><circle cx="12" cy="11" r="2.2"/>',
  bell: '<path d="M6.5 17.5V11a5.5 5.5 0 0 1 11 0v6.5l1.5 2.5H5z"/><path d="M10 21.5h4"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};

const TEMPLATE = document.createElement("template");

export function iconHTML(name, extra = "") {
  const body = PATHS[name] || PATHS.dot;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
}

export function icon(name, extra = "") {
  TEMPLATE.innerHTML = iconHTML(name, extra);
  return TEMPLATE.content.firstElementChild;
}

export const ICON_NAMES = Object.keys(PATHS);

/* --------------------------------------------------------------------------
   Product icon set ? Bootstrap-icon style object glyphs for catalog items.
   Names are what gets stored on the product (e.g. "cup-hot", "tv", "drill").
   -------------------------------------------------------------------------- */
const PRODUCT_PATHS = {
  box: '<path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5z"/><path d="M3 8.5 12 14l9-5.5"/><path d="M12 14v7"/>',
  "cup-hot": '<path d="M4 8h11v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M15 9h2.5a2.5 2.5 0 0 1 0 5H15"/><path d="M7 3.5c-.8.9-.8 1.6 0 2.5M10.5 3.5c-.8.9-.8 1.6 0 2.5"/>',
  cup: '<path d="M5 7h11v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M5 7h11"/>',
  "cup-straw": '<path d="M5 8h11l-1.2 9.2A3 3 0 0 1 11.8 20H9.2a3 3 0 0 1-3-2.8z"/><path d="m13 8 2-5"/><path d="M5 11h11"/>',
  bread: '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 0 8v4H4z"/><path d="M8 12v6M12 12v6M16 12v6"/>',
  cake: '<path d="M5 20h14v-6a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3z"/><path d="M5 15c1.5 1 3 1 4.5 0S12 14 13.5 15s3 1 4.5 0"/><path d="M12 8V5"/><path d="M12 3.5h.01"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  tv: '<rect x="2.5" y="4.5" width="19" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/>',
  speaker: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><circle cx="12" cy="15" r="3"/><circle cx="12" cy="7" r="1.4"/>',
  headset: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4" height="6" rx="1.6"/><rect x="17.5" y="13" width="4" height="6" rx="1.6"/><path d="M19.5 19v.5a2.5 2.5 0 0 1-2.5 2.5h-3"/>',
  solar: '<rect x="3" y="4" width="18" height="11" rx="1.5"/><path d="M9 4v11M15 4v11M3 9.5h18"/><path d="M12 15v4M8 20h8"/>',
  bolt: '<path d="M13 2 5 14h6l-1 8 8-12h-6z"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3M13 10.5v3"/>',
  microwave: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><rect x="5" y="8" width="10" height="8" rx="1"/><path d="M18 9h.01M18 12h.01M18 15h.01"/>',
  kettle: '<path d="M6 9h9v7a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z"/><path d="M15 11h2.5a2 2 0 0 1 0 4H15"/><path d="M9 9V6h3v3"/><path d="M6 9 4 7"/>',
  drill: '<path d="M3 10h11v4H3z"/><path d="M14 11h3l4 2-4 3h-3z"/><path d="M6 14v4h5v-4"/><path d="M7 10V7h6v3"/>',
  tools: '<path d="M14.5 3.5a4.5 4.5 0 0 0-6 6L3 15l3 3 5.5-5.5a4.5 4.5 0 0 0 6-6L15 9l-2.5-.5L12 6z"/>',
  paint: '<path d="M4 9h10v6H4z"/><path d="M9 9V6h6a2 2 0 0 1 0 4h-1"/><path d="M6 15v3a2 2 0 0 0 2 2h2"/>',
  ruler: '<rect x="2.5" y="8" width="19" height="8" rx="1.6"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
  pipe: '<path d="M4 6h7a4 4 0 0 1 4 4v8"/><path d="M2.5 4.5h3v3h-3z"/><path d="M13 16.5h3v3h-3z"/>',
  droplet: '<path d="M12 3.5s6 6 6 10a6 6 0 0 1-12 0c0-4 6-10 6-10z"/>',
  fuel: '<rect x="4" y="4" width="9" height="16" rx="1.6"/><path d="M6.5 7h4"/><path d="M13 9h3l3 3v6a1.5 1.5 0 0 1-3 0v-3h-3"/>',
  sofa: '<path d="M4 12V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M2.5 12h19v6h-2v2h-3v-2H8.5v2h-3v-2h-3z"/><path d="M6 12v-2M18 12v-2"/>',
  table: '<path d="M3 8h18"/><path d="M5 8v12M19 8v12"/><path d="M3 8l1.5-3h15L21 8"/><path d="M5 12h14"/>',
  chair: '<path d="M7 3.5h10v9H7z"/><path d="M5 12.5h14v3H5z"/><path d="M7 15.5v5M17 15.5v5"/>',
  plate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/>',
  pot: '<path d="M4 10h16v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M2.5 10h19"/><path d="M8 7c0-1 1-1.5 1-2.5M12 7c0-1 1-1.5 1-2.5M16 7c0-1 1-1.5 1-2.5"/>',
  glass: '<path d="M7 3h10l-1 7a4 4 0 0 1-8 0z"/><path d="M12 14v6M8 20h8"/>',
  shirt: '<path d="M8 3 4 6l2 3 2-1v13h8V8l2 1 2-3-4-3-3 2z"/>',
  gem: '<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3 7 9l5 12M15 3l2 6-5 12"/>',
  star: '<path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.2l2.4 11.2h11.6l1.8-8H6"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
};

export const PRODUCT_ICON_NAMES = Object.keys(PRODUCT_PATHS);

export function productIconHTML(name = "box", cls = "product-icon") {
  const body = PRODUCT_PATHS[name] || PRODUCT_PATHS.box;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function productIcon(name = "box", cls = "product-icon") {
  TEMPLATE.innerHTML = productIconHTML(name, cls);
  return TEMPLATE.content.firstElementChild;
}

