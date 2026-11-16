/* Dependency-free SVG charts. */

import { h, clear } from "./dom.js";
import { money, number } from "./fmt.js";

const NS = "http://www.w3.org/2000/svg";
let uid = 0;

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function niceMax(value) {
  if (!value || value <= 0) return 10;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function areaChart({ points = [], labels = [], height = 240, color = "var(--primary)", formatValue = money,
  series = null } = {}) {
  const width = 960;
  const padLeft = 52;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const id = `grad${++uid}`;

  const dataSeries = series && series.length
    ? series
    : [{ name: "Sales", color, values: points }];
  const allValues = dataSeries.flatMap((line) => line.values || []);
  const max = niceMax(Math.max(...allValues, 1));

  const count = Math.max((dataSeries[0].values || []).length, 1);
  const xFor = (index) => padLeft + (count === 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const yFor = (value) => padTop + plotH - (value / max) * plotH;

  const svg = s("svg", {
    class: "chart",
    viewBox: `0 0 ${width} ${height}`,
    style: `height:${height}px;width:100%`,
    role: "img",
  });

  const defs = s("defs");
  for (const line of dataSeries) {
    const gradient = s("linearGradient", { id: `${id}-${line.name.replace(/\W/g, "")}`, x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.appendChild(s("stop", { offset: "0%", "stop-color": line.color || color, "stop-opacity": ".34" }));
    gradient.appendChild(s("stop", { offset: "100%", "stop-color": line.color || color, "stop-opacity": "0" }));
    defs.appendChild(gradient);
  }
  svg.appendChild(defs);

  const grid = s("g", { class: "chart__grid" });
  for (let i = 0; i <= 4; i += 1) {
    const value = (max / 4) * i;
    const y = yFor(value);
    grid.appendChild(s("line", { x1: padLeft, x2: width - padRight, y1: y, y2: y }));
    grid.appendChild(s("text", { x: padLeft - 8, y: y + 3, "text-anchor": "end" }, shortValue(value)));
  }
  svg.appendChild(grid);

  const labelStep = Math.ceil(count / 7);
  const labelGroup = s("g");
  for (let i = 0; i < count; i += labelStep) {
    labelGroup.appendChild(
      s("text", { x: xFor(i), y: height - 8, "text-anchor": "middle" }, labels[i] || "")
    );
  }
  if (count > 1 && (count - 1) % labelStep !== 0) {
    labelGroup.appendChild(s("text", { x: xFor(count - 1), y: height - 8, "text-anchor": "middle" }, labels[count - 1] || ""));
  }
  svg.appendChild(labelGroup);

  for (const line of dataSeries) {
    const values = line.values || [];
    if (!values.length) continue;
    const stroke = line.color || color;
    const path = values.map((value, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`).join(" ");
    const areaPath = `${path} L${xFor(values.length - 1).toFixed(1)},${padTop + plotH} L${xFor(0).toFixed(1)},${padTop + plotH} Z`;
    svg.appendChild(s("path", {
      d: areaPath,
      fill: `url(#${id}-${line.name.replace(/\W/g, "")})`,
      class: "chart__area",
    }));
    svg.appendChild(s("path", { d: path, class: "chart__line", stroke }));
    values.forEach((value, index) => {
      if (count > 4 && index % Math.max(1, Math.floor(count / 6)) !== 0 && index !== count - 1) return;
      const dot = s("circle", {
        cx: xFor(index), cy: yFor(value), r: 3, fill: stroke, class: "chart__dot",
      });
      const title = s("title", {}, `${labels[index] || ""} · ${formatValue(value)}`);
      dot.appendChild(title);
      svg.appendChild(dot);
    });
  }

  return svg;
}

function shortValue(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

export function donutChart({ segments = [], size = 168, thickness = 18, formatValue = money, centerLabel = "Total" } = {}) {
  const total = segments.reduce((sum, seg) => sum + (Number(seg.value) || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${size} ${size}`, style: `width:${size}px;height:${size}px` });
  svg.appendChild(s("circle", {
    cx: size / 2, cy: size / 2, r: radius, fill: "none",
    stroke: "var(--surface-3)", "stroke-width": thickness,
  }));
  let offset = 0;
  for (const segment of segments) {
    const fraction = total > 0 ? (Number(segment.value) || 0) / total : 0;
    const length = fraction * circumference;
    if (length <= 0) continue;
    const circle = s("circle", {
      cx: size / 2, cy: size / 2, r: radius, fill: "none",
      stroke: segment.color || "var(--primary)",
      "stroke-width": thickness,
      "stroke-dasharray": `${length} ${circumference - length}`,
      "stroke-dashoffset": -offset,
      "stroke-linecap": "butt",
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    circle.appendChild(s("title", {}, `${segment.label}: ${formatValue(segment.value)}`));
    svg.appendChild(circle);
    offset += length;
  }
  svg.appendChild(s("text", {
    x: size / 2, y: size / 2 - 2, "text-anchor": "middle",
    style: "font-size:19px;font-weight:700;fill:var(--text)",
  }, formatValue(total, { bare: false })));
  svg.appendChild(s("text", {
    x: size / 2, y: size / 2 + 15, "text-anchor": "middle",
    style: "font-size:10px;letter-spacing:.1em;text-transform:uppercase;fill:var(--text-3)",
  }, centerLabel));
  return svg;
}

export function barList({ rows = [], formatValue = money, color = "var(--primary)" } = {}) {
  const max = Math.max(...rows.map((row) => Number(row.value) || 0), 1);
  const wrap = h("div", { class: "bars" });
  for (const row of rows) {
    const width = Math.max(3, Math.round(((Number(row.value) || 0) / max) * 100));
    wrap.appendChild(h("div", { class: "bar-row" },
      h("div", { class: "bar-row__label", title: row.label }, row.label),
      h("div", { class: "bar-row__value" }, formatValue(row.value)),
      h("div", { class: "bar-row__track" },
        h("div", { class: "bar-row__fill", style: { width: `${width}%`, background: row.color || color } }))));
  }
  if (!rows.length) wrap.appendChild(h("div", { class: "dim small center", style: { padding: "18px" } }, "No data yet"));
  return wrap;
}

export function legend(items) {
  return h("div", { class: "chart-legend" },
    items.map((item) => h("div", { class: "chart-legend__item" },
      h("span", { class: "chart-legend__swatch", style: { background: item.color } }),
      h("span", {}, item.label),
      item.value != null ? h("span", { class: "dim" }, item.value) : null)));
}

export function heatStrip(values = []) {
  const max = Math.max(...values, 1);
  return h("div", { class: "heat" },
    values.map((value, hour) => {
      const level = value / max;
      return h("div", {
        class: "heat__cell",
        title: `${String(hour).padStart(2, "0")}:00 · ${number(value)}`,
        style: {
          background: level > 0.02
            ? `color-mix(in srgb, var(--primary) ${Math.round(18 + level * 82)}%, var(--surface-3))`
            : "var(--surface-3)",
        },
      });
    }));
}

export function sparkline(values = [], { color = "var(--primary)", width = 120, height = 32 } = {}) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const path = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return s("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, style: `width:${width}px;height:${height}px` },
    s("path", { d: path, fill: "none", stroke: color, "stroke-width": "1.8", "stroke-linecap": "round" }));
}

export const chartUtils = { niceMax, shortValue };
