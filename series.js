/**
 * 趋势折线与构成环图。
 *
 * 两个约束决定了这里的写法：
 * 1. CSP 是 `style-src 'self'`，所以只能设几何属性（x/y/d/cx…）和 class，不能设 style 属性，
 *    颜色一律由 styles.css 决定 —— 深浅色主题也因此自动跟着走。
 * 2. 视图切换（发卡/激活/到期/收入）只换画哪一列，绝不重新请求：
 *    四个视图必须来自同一批 buckets，否则用户会在同一张图上看到互相矛盾的当天数字。
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_HEIGHT = 224;
const METRICS = {
  issued: { key: "issued", label: "发卡", unit: "张" },
  activated: { key: "activated", label: "激活", unit: "张" },
  expired: { key: "expired", label: "到期", unit: "张" },
  revenue: { key: "revenueCents", label: "收入", unit: "元" },
};

function node(name, attrs, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function niceCeil(value) {
  if (!(value > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * base >= value) return step * base;
  return 10 * base;
}

function shortDate(date) {
  const parts = String(date).split("-");
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : String(date);
}

function axisLabel(value, unit) {
  if (unit === "元") return value >= 10000 ? `${Math.round(value / 10000)}万` : String(Math.round(value * 10) / 10);
  // 计数轴的中间刻度常常是 0.5 这种半整数；直接四舍五入会让"1 天"这种小窗口
  // 出现 1 / 1 / 0 三行重复标签，所以保留一位小数。
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function valueOf(bucket, metric) {
  const raw = Number(bucket[METRICS[metric].key] || 0);
  return metric === "revenue" ? raw / 100 : raw;
}

/**
 * 悬停提示。用真正的浮层而不是 SVG 原生 <title>：原生提示要悬停约一秒才出现、
 * 样式不可控、也没法一次给出这一天的四个指标。
 *
 * 监听器只绑一次（svg.__seriesBound），数据放在 svg.__series 上按次刷新 ——
 * 否则每 5 分钟一次自动重绘就会叠一层监听器。
 */
const TIP_ROWS = [
  { key: "issued", label: "发卡", unit: "张" },
  { key: "activated", label: "激活", unit: "张" },
  { key: "expired", label: "到期", unit: "张" },
  { key: "revenueCents", label: "收入", unit: "元", divide: 100 },
];

function fillTip(tip, bucket, activeMetric) {
  while (tip.firstChild) tip.removeChild(tip.firstChild);
  const head = document.createElement("span");
  head.className = "chart-tip__date";
  head.textContent = bucket.date;
  tip.append(head);
  for (const row of TIP_ROWS) {
    const raw = Number(bucket[row.key] || 0);
    const value = row.divide ? raw / row.divide : raw;
    const line = document.createElement("span");
    line.className = "chart-tip__row";
    const active = METRICS[activeMetric] && METRICS[activeMetric].key === row.key;
    if (active) line.classList.add("is-active");
    const name = document.createElement("i");
    name.textContent = row.label;
    const num = document.createElement("b");
    num.textContent = `${row.divide ? value.toFixed(2) : value} ${row.unit}`;
    line.append(name, num);
    tip.append(line);
  }
}

function moveCursor(svg, index) {
  const ctx = svg.__series;
  if (!ctx || !ctx.rows.length) return;
  const clamped = Math.max(0, Math.min(ctx.rows.length - 1, index));
  ctx.index = clamped;
  const x = ctx.xAt(clamped);
  const y = ctx.yAt(ctx.values[clamped]);
  ctx.guide.setAttribute("x1", x);
  ctx.guide.setAttribute("x2", x);
  ctx.guide.classList.add("is-on");
  ctx.cursor.setAttribute("cx", x);
  ctx.cursor.setAttribute("cy", y);
  ctx.cursor.classList.add("is-on");
  if (ctx.tip) {
    fillTip(ctx.tip, ctx.rows[clamped], ctx.metric);
    ctx.tip.hidden = false;
    const width = ctx.tip.offsetWidth || 150;
    ctx.tip.style.setProperty("left", `${Math.max(8, Math.min(x + 14, ctx.width - width - 8))}px`);
    ctx.tip.style.setProperty("top", `${ctx.pad.top}px`);
  }
}

function hideCursor(svg) {
  const ctx = svg.__series;
  if (!ctx) return;
  ctx.guide.classList.remove("is-on");
  ctx.cursor.classList.remove("is-on");
  if (ctx.tip) ctx.tip.hidden = true;
}

function indexFromPointer(svg, event) {
  const ctx = svg.__series;
  if (!ctx) return -1;
  const rect = svg.getBoundingClientRect();
  // 重绘之后容器可能已经变宽（例如刚折叠过侧栏），按当前显示宽度换算回绘制坐标。
  const scale = ctx.width ? rect.width / ctx.width : 1;
  const x = (event.clientX - rect.left) / scale;
  const step = ctx.stepX || 1;
  return Math.round((x - ctx.pad.left) / step);
}

function ensureInteraction(svg, tip) {
  if (svg.__seriesBound) return;
  svg.__seriesBound = true;
  svg.addEventListener("pointermove", (event) => {
    const index = indexFromPointer(svg, event);
    if (index < 0 || !svg.__series) return;
    moveCursor(svg, index);
  });
  svg.addEventListener("pointerleave", () => hideCursor(svg));
  svg.addEventListener("blur", () => hideCursor(svg));
  svg.addEventListener("keydown", (event) => {
    const ctx = svg.__series;
    if (!ctx) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const from = ctx.index == null ? ctx.rows.length - 1 : ctx.index;
      moveCursor(svg, from + (event.key === "ArrowRight" ? 1 : -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      moveCursor(svg, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveCursor(svg, ctx.rows.length - 1);
    } else if (event.key === "Escape") {
      hideCursor(svg);
    }
  });
  svg.addEventListener("focus", () => {
    const ctx = svg.__series;
    if (ctx && ctx.rows.length) moveCursor(svg, ctx.index == null ? ctx.rows.length - 1 : ctx.index);
  });
  if (tip) tip.dataset.ready = "1";
}

export function renderLineChart(svg, buckets, metric) {
  if (!svg) return;
  const definition = METRICS[metric] || METRICS.issued;
  const rows = Array.isArray(buckets) ? buckets : [];
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!rows.length) {
    // 清掉上一次的上下文，否则空数据时悬停还会读出旧的一天。
    svg.__series = null;
    const staleTip = document.getElementById("series-tip");
    if (staleTip) staleTip.hidden = true;
    svg.setAttribute("aria-label", "暂无趋势数据");
    return;
  }

  const width = Math.max(320, Math.round(svg.getBoundingClientRect().width || 640));
  const pad = { left: 40, right: 12, top: 14, bottom: 24 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = CHART_HEIGHT - pad.top - pad.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", CHART_HEIGHT);

  const values = rows.map((bucket) => valueOf(bucket, metric));
  const peak = Math.max(...values, 0);
  const ceiling = niceCeil(peak || 1);
  const stepX = rows.length > 1 ? innerWidth / (rows.length - 1) : 0;
  const xAt = (index) => pad.left + (rows.length > 1 ? index * stepX : innerWidth / 2);
  const yAt = (value) => pad.top + innerHeight * (1 - value / ceiling);
  const baseline = pad.top + innerHeight;

  for (const ratio of [0, 0.5, 1]) {
    const value = ceiling * ratio;
    const y = yAt(value);
    svg.append(node("line", { class: "axis-line", x1: pad.left, y1: y, x2: width - pad.right, y2: y }));
    svg.append(node("text", { class: "axis-text", x: pad.left - 8, y: y + 3.5, "text-anchor": "end" }, axisLabel(value, definition.unit)));
  }

  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(values.length - 1).toFixed(1)},${baseline} L${xAt(0).toFixed(1)},${baseline} Z`;
  svg.append(node("path", { class: `series-area metric-${metric}`, d: area }));
  svg.append(node("path", { class: `series-line metric-${metric}`, d: line }));

  // 手机上 6 个横轴标签会糊成一排，按容器宽度收着放。
  const labelCount = Math.min(width < 520 ? 3 : width < 900 ? 5 : 6, rows.length);
  for (let index = 0; index < labelCount; index += 1) {
    const position = Math.round((index * (rows.length - 1)) / Math.max(1, labelCount - 1));
    svg.append(node("text", {
      class: "axis-text",
      x: xAt(position),
      y: CHART_HEIGHT - 6,
      "text-anchor": position === 0 ? "start" : position === rows.length - 1 ? "end" : "middle",
    }, shortDate(rows[position].date)));
  }

  // 每天一根透明命中条 + 原生 <title>：不写一行 JS 就能悬停看具体数字，
  // 也不会因为多一层 JS 状态而在自动刷新时和表格对不上。
  rows.forEach((bucket, index) => {
    const value = valueOf(bucket, metric);
    const tip = `${bucket.date} · ${definition.label} ${axisLabel(value, definition.unit)} ${definition.unit}`;
    const hit = node("rect", {
      class: "series-hit",
      x: xAt(index) - stepX / 2,
      y: pad.top,
      width: Math.max(1, stepX || innerWidth),
      height: innerHeight,
    });
    hit.append(node("title", {}, tip));
    svg.append(hit);
  });

  const lastIndex = values.length - 1;
  svg.append(node("circle", {
    class: `series-dot metric-${metric} is-visible`,
    cx: xAt(lastIndex),
    cy: yAt(values[lastIndex]),
    r: 3.2,
  }));

  // 悬停用的竖线 + 高亮点：每次重绘都重建，位置由 moveCursor 改。
  const guide = node("line", { class: "chart-guide", x1: 0, y1: pad.top, x2: 0, y2: baseline });
  const cursor = node("circle", { class: `series-cursor metric-${metric}`, cx: xAt(lastIndex), cy: yAt(values[lastIndex]), r: 4.2 });
  svg.append(guide, cursor);

  const tip = document.getElementById("series-tip");
  svg.__series = { rows, values, metric, width, pad, stepX, xAt, yAt, guide, cursor, tip, index: null };
  ensureInteraction(svg, tip);

  const total = values.reduce((sum, value) => sum + value, 0);
  svg.setAttribute("aria-label", `近 ${rows.length} 天${definition.label}趋势，合计 ${axisLabel(total, definition.unit)} ${definition.unit}，最高一天 ${axisLabel(peak, definition.unit)} ${definition.unit}。聚焦后可用左右方向键逐日查看。`);
}

export function renderDonut(svg, slices) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const size = 118;
  const radius = 45;
  const circumference = 2 * Math.PI * radius;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.append(node("circle", { class: "donut-track", cx: size / 2, cy: size / 2, r: radius }));

  const rows = Array.isArray(slices) ? slices : [];
  const total = rows.reduce((sum, slice) => sum + Number(slice.value || 0), 0);
  let offset = 0;
  for (const slice of rows) {
    const value = Number(slice.value || 0);
    if (!total || value <= 0) continue;
    const length = (value / total) * circumference;
    const arc = node("circle", {
      class: `donut-slice slice-${slice.key}`,
      cx: size / 2,
      cy: size / 2,
      r: radius,
      "stroke-dasharray": `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
      "stroke-dashoffset": (-offset).toFixed(2),
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    });
    arc.append(node("title", {}, `${slice.label} ${value} 张（${Math.round((value / total) * 100)}%）`));
    svg.append(arc);
    offset += length;
  }

  svg.append(node("text", { class: "donut-total", x: size / 2, y: size / 2 + 2 }, String(total)));
  svg.append(node("text", { class: "donut-caption", x: size / 2, y: size / 2 + 16 }, "总激活码"));
  svg.setAttribute("aria-label", total
    ? `库存构成合计 ${total} 张：${rows.map((slice) => `${slice.label} ${slice.value} 张`).join("，")}。`
    : "库存为空，暂无激活码。");
}
