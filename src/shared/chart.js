/* Odoo Import Export: charts as SVG, no library.
 *
 * Forms: "bar" (columns, stacked for a second group-by), "hbar" (horizontal bars, for
 * many or long names), "line" (dates), "pie" and "donut" (part-to-whole, <= 6 slices).
 * Colors are the validated categorical palette in fixed slot order; "Others" is neutral
 * gray; a single series uses slot 1 for every mark. Colors are concrete values (no CSS
 * variables) so the same SVG can be saved as an image.
 *
 * render(data, opts) -> {svg, height}; marks carry `__tip` = {title, rows: [{label, value, color}]}.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const SVGNS = "http://www.w3.org/2000/svg";

  const THEMES = {
    light: {
      surface: "#fcfcfb", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7", others: "#b4b2aa",
      series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    },
    dark: {
      surface: "#1a1a19", ink: "#f0efec", ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835", others: "#5c5b56",
      series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
    },
  };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    if (parent) parent.append(node);
    return node;
  }

  function text(parent, x, y, content, attrs = {}) {
    const t = el("text", { x, y, "font-family": FONT, "font-size": 12, ...attrs }, parent);
    t.textContent = content;
    return t;
  }

  let ctx2d = null;
  function measure(s, size = 12, weight = 400) {
    if (!ctx2d) ctx2d = document.createElement("canvas").getContext("2d");
    ctx2d.font = `${weight} ${size}px ${FONT}`;
    return ctx2d.measureText(String(s)).width;
  }

  // Cut a label to fit `width` px, with an ellipsis.
  function fit(s, width, size = 12) {
    s = String(s);
    if (measure(s, size) <= width) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(`${s.slice(0, mid)}…`, size) <= width) lo = mid;
      else hi = mid - 1;
    }
    return lo ? `${s.slice(0, lo)}…` : "";
  }

  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return `${+n.toFixed(2)}`;
  }

  const full = (n) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

  // Round tick values covering [min, max].
  function ticks(min, max, count = 5) {
    if (min === max) max = min + 1;
    const span = max - min;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function colorFor(theme, series, i, single) {
    if (series.others || series.compare) return theme.others; // "Others" and the compared period: neutral gray
    return single ? theme.series[0] : theme.series[i % theme.series.length];
  }

  // A column/bar with a 4px rounded data end and a square base.
  function barPath(x, y, w, h, horizontal, positive = true) {
    const r = Math.min(4, (horizontal ? h : w) / 2, Math.abs(horizontal ? w : h));
    if (!horizontal) {
      if (positive) return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
      return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
    }
    if (positive) return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
    return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
  }

  function legend(svg, theme, items, x, y, width) {
    // Wrapping row of swatches: [■ label] [■ label] ...
    let cx = x;
    let cy = y;
    for (const it of items) {
      const label = fit(it.label, 180);
      const w = 14 + measure(label) + 18;
      if (cx + w > x + width && cx > x) {
        cx = x;
        cy += 20;
      }
      if (it.line) el("line", { x1: cx, y1: cy - 4, x2: cx + 10, y2: cy - 4, stroke: it.color, "stroke-width": 2, "stroke-linecap": "round" }, svg);
      else el("rect", { x: cx, y: cy - 9, width: 10, height: 10, rx: 2, fill: it.color }, svg);
      text(svg, cx + 14, cy, label, { fill: theme.ink2 });
      cx += w;
    }
    return cy + 12;
  }

  function title(svg, theme, opts, width) {
    let y = 0;
    if (opts.title) {
      y += 18;
      text(svg, 0, y, fit(opts.title, width, 15), { fill: theme.ink, "font-size": 15, "font-weight": 600 });
    }
    if (opts.subtitle) {
      y += 18;
      text(svg, 0, y, fit(opts.subtitle, width), { fill: theme.ink2 });
    }
    return y ? y + 12 : 0;
  }

  // ---------------------------------------------------------------------------
  // columns and horizontal bars: stacked when there are several series, side by side when
  // they are two periods compared (data.compare)
  function bars(svg, data, opts, theme, top, horizontal) {
    const { width } = opts;
    const single = data.series.length === 1;
    const grouped = !!data.compare;
    const cats = data.categories;
    const n = cats.length;
    // stack positives up and negatives down, per category (side by side: the largest bar)
    const pos = cats.map((_, i) => (grouped ? Math.max(0, ...data.series.map((s) => s.values[i])) : data.series.reduce((a, s) => a + Math.max(0, s.values[i]), 0)));
    const neg = cats.map((_, i) => (grouped ? Math.min(0, ...data.series.map((s) => s.values[i])) : data.series.reduce((a, s) => a + Math.min(0, s.values[i]), 0)));
    const tv = ticks(Math.min(0, ...neg), Math.max(0, ...pos));
    const lo = tv[0];
    const hi = tv[tv.length - 1];
    const labelValues = single && n <= 15;

    let y = top;
    if (!single) y = legend(svg, theme, data.series.map((s, i) => ({ label: s.label, color: colorFor(theme, s, i, false) })), 0, y + 12, width) + 6;

    if (!horizontal) {
      const axisW = Math.max(...tv.map((t) => measure(compact(t), 11))) + 10;
      const plotX = axisW;
      const plotW = width - plotX;
      const plotH = 260;
      const plotY = y + 10;
      const scale = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
      for (const t of tv) {
        el("line", { x1: plotX, x2: width, y1: scale(t), y2: scale(t), stroke: t === 0 ? theme.axis : theme.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
        text(svg, plotX - 8, scale(t) + 4, compact(t), { fill: theme.muted, "font-size": 11, "text-anchor": "end" });
      }
      const band = plotW / n;
      const bw = Math.max(4, Math.min(24, band * 0.6));
      const every = Math.max(1, Math.ceil(56 / band)); // label every Nth category when crowded
      if (grouped) {
        const k = data.series.length;
        const sw = Math.max(3, Math.min(24, (band * 0.7 - 2 * (k - 1)) / k));
        cats.forEach((c, i) => {
          const cx = plotX + band * i + band / 2;
          const x0 = cx - (k * sw + 2 * (k - 1)) / 2;
          data.series.forEach((s, j) => {
            const v = s.values[i];
            if (!v) return;
            const yv = scale(v);
            const y0 = scale(0);
            const mark = el("path", { d: barPath(x0 + j * (sw + 2), Math.min(yv, y0), sw, Math.max(1, Math.abs(y0 - yv)), false, v > 0), fill: colorFor(theme, s, j, false), class: "mark", tabindex: 0, role: "img", "aria-label": `${c.label}, ${s.label}: ${full(v)}` }, svg);
            mark.__tip = tip(c, data, i, theme, false);
          });
          if (i % every === 0) text(svg, cx, plotY + plotH + 16, fit(c.label, band * every - 6, 11), { fill: theme.ink2, "font-size": 11, "text-anchor": "middle" });
        });
        return plotY + plotH + 28;
      }
      cats.forEach((c, i) => {
        const cx = plotX + band * i + band / 2;
        let up = 0;
        let down = 0;
        data.series.forEach((s, k) => {
          const v = s.values[i];
          if (!v) return;
          const base = v > 0 ? up : down;
          const y0 = scale(base);
          const y1 = scale(base + v);
          const gap = data.series.length > 1 ? 1 : 0;
          const top2 = Math.min(y0, y1) + (v > 0 ? gap : 0);
          const h = Math.max(1, Math.abs(y1 - y0) - gap);
          const isEnd = v > 0 ? data.series.slice(k + 1).every((s2) => !(s2.values[i] > 0)) : data.series.slice(k + 1).every((s2) => !(s2.values[i] < 0));
          const d = isEnd ? barPath(cx - bw / 2, top2, bw, h, false, v > 0) : `M${cx - bw / 2},${top2}h${bw}v${h}h${-bw}Z`;
          const mark = el("path", { d, fill: single && c.others ? theme.others : colorFor(theme, s, k, single), class: "mark", tabindex: 0, role: "img", "aria-label": `${c.label}${s.label ? `, ${s.label}` : ""}: ${full(v)}` }, svg);
          mark.__tip = tip(c, data, i, theme, single);
          if (v > 0) up += v;
          else down += v;
        });
        if (labelValues && data.series[0].values[i]) {
          const v = data.series[0].values[i];
          text(svg, cx, v >= 0 ? scale(v) - 6 : scale(v) + 14, compact(v), { fill: theme.ink2, "font-size": 11, "text-anchor": "middle" });
        }
        if (i % every === 0) text(svg, cx, plotY + plotH + 16, fit(c.label, band * every - 6, 11), { fill: theme.ink2, "font-size": 11, "text-anchor": "middle" });
      });
      return plotY + plotH + 28;
    }

    // horizontal
    // room for the longest label (plus its 10px gap and a little slack), at most a third of the width
    const labelW = Math.min(width * 0.32, Math.max(...cats.map((c) => measure(c.label))) + 20);
    const valueW = labelValues ? Math.max(...data.series[0].values.map((v) => measure(compact(v), 11))) + 10 : 0;
    const plotX = labelW;
    const plotW = width - labelW - valueW;
    const rowH = grouped ? data.series.length * 14 + 2 * (data.series.length - 1) + 14 : 32;
    const plotY = y + 8;
    const scale = (v) => plotX + ((v - lo) / (hi - lo)) * plotW;
    const plotH = n * rowH;
    for (const t of tv) {
      el("line", { x1: scale(t), x2: scale(t), y1: plotY, y2: plotY + plotH, stroke: t === 0 ? theme.axis : theme.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
      text(svg, scale(t), plotY + plotH + 16, compact(t), { fill: theme.muted, "font-size": 11, "text-anchor": "middle" });
    }
    const bh = Math.min(24, rowH - 8);
    cats.forEach((c, i) => {
      const cy = plotY + rowH * i + rowH / 2;
      text(svg, labelW - 10, cy + 4, fit(c.label, labelW - 14), { fill: theme.ink2, "text-anchor": "end" });
      if (grouped) {
        const k = data.series.length;
        const y0 = cy - (k * 14 + 2 * (k - 1)) / 2;
        data.series.forEach((s, j) => {
          const v = s.values[i];
          if (!v) return;
          const xv = scale(v);
          const x0 = scale(0);
          const mark = el("path", { d: barPath(Math.min(xv, x0), y0 + j * 16, Math.max(1, Math.abs(xv - x0)), 14, true, v > 0), fill: colorFor(theme, s, j, false), class: "mark", tabindex: 0, role: "img", "aria-label": `${c.label}, ${s.label}: ${full(v)}` }, svg);
          mark.__tip = tip(c, data, i, theme, false);
        });
        return;
      }
      let right = 0;
      let left = 0;
      data.series.forEach((s, k) => {
        const v = s.values[i];
        if (!v) return;
        const base = v > 0 ? right : left;
        const x0 = scale(base);
        const x1 = scale(base + v);
        const gap = data.series.length > 1 ? 1 : 0;
        const w = Math.max(1, Math.abs(x1 - x0) - gap);
        const xl = Math.min(x0, x1) + (v < 0 ? gap : 0);
        const isEnd = v > 0 ? data.series.slice(k + 1).every((s2) => !(s2.values[i] > 0)) : data.series.slice(k + 1).every((s2) => !(s2.values[i] < 0));
        const d = isEnd ? barPath(xl, cy - bh / 2, w, bh, true, v > 0) : `M${xl},${cy - bh / 2}h${w}v${bh}h${-w}Z`;
        const mark = el("path", { d, fill: single && c.others ? theme.others : colorFor(theme, s, k, single), class: "mark", tabindex: 0, role: "img", "aria-label": `${c.label}${s.label ? `, ${s.label}` : ""}: ${full(v)}` }, svg);
        mark.__tip = tip(c, data, i, theme, single);
        if (v > 0) right += v;
        else left += v;
      });
      if (labelValues) {
        const v = data.series[0].values[i];
        text(svg, v >= 0 ? scale(v) + 6 : scale(v) - 6, cy + 4, compact(v), { fill: theme.ink2, "font-size": 11, "text-anchor": v >= 0 ? "start" : "end" });
      }
    });
    return plotY + plotH + 28;
  }

  function tip(c, data, i, theme, single) {
    return {
      title: c.label,
      rows: data.series.map((s, k) => ({ label: s.label || data.measureLabel, value: full(s.values[i]), color: single && c.others ? theme.others : colorFor(theme, s, k, single) })),
    };
  }

  // ---------------------------------------------------------------------------
  // lines (dates): one per series, markers when the points are few, crosshair hit bands
  function lines(svg, data, opts, theme, top) {
    const { width } = opts;
    const single = data.series.length === 1;
    const cats = data.categories;
    const n = cats.length;
    const all = data.series.flatMap((s) => s.values);
    const tv = ticks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = tv[0];
    const hi = tv[tv.length - 1];
    let y = top;
    if (!single) y = legend(svg, theme, data.series.map((s, i) => ({ label: s.label, color: colorFor(theme, s, i, false), line: true })), 0, y + 12, width) + 6;
    const axisW = Math.max(...tv.map((t) => measure(compact(t), 11))) + 10;
    const plotX = axisW + 6;
    const plotW = width - plotX - 12;
    const plotH = 260;
    const plotY = y + 10;
    const sx = (i) => plotX + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
    const sy = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH;
    for (const t of tv) {
      el("line", { x1: plotX, x2: plotX + plotW, y1: sy(t), y2: sy(t), stroke: t === 0 ? theme.axis : theme.grid, "stroke-width": 1, "shape-rendering": "crispEdges" }, svg);
      text(svg, plotX - 8, sy(t) + 4, compact(t), { fill: theme.muted, "font-size": 11, "text-anchor": "end" });
    }
    const every = Math.max(1, Math.ceil(80 / (plotW / Math.max(1, n - 1))));
    cats.forEach((c, i) => {
      if (i % every === 0 || i === n - 1) text(svg, sx(i), plotY + plotH + 16, fit(c.label, 90, 11), { fill: theme.ink2, "font-size": 11, "text-anchor": i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle" });
    });
    const crosshair = el("line", { x1: 0, x2: 0, y1: plotY, y2: plotY + plotH, stroke: theme.axis, "stroke-width": 1, visibility: "hidden", class: "crosshair" }, svg);
    data.series.forEach((s, k) => {
      const color = colorFor(theme, s, k, single);
      const d = s.values.map((v, i) => `${i ? "L" : "M"}${sx(i)},${sy(v)}`).join("");
      if (single) el("path", { d: `${d}L${sx(n - 1)},${sy(Math.max(lo, 0))}L${sx(0)},${sy(Math.max(lo, 0))}Z`, fill: color, "fill-opacity": 0.1 }, svg);
      el("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (n <= 40) s.values.forEach((v, i) => el("circle", { cx: sx(i), cy: sy(v), r: 4, fill: color, stroke: theme.surface, "stroke-width": 2 }, svg));
      // label the end of a single line
      if (single && n) text(svg, sx(n - 1) - 2, sy(s.values[n - 1]) - 10, compact(s.values[n - 1]), { fill: theme.ink2, "font-size": 11, "text-anchor": "end" });
    });
    // one invisible hit band per x: the pointer only has to be near the date
    cats.forEach((c, i) => {
      const half = n === 1 ? plotW / 2 : plotW / (n - 1) / 2;
      const band = el("rect", { x: sx(i) - half, y: plotY, width: half * 2, height: plotH, fill: "transparent", class: "mark band", tabindex: 0, "aria-label": `${c.label}: ${data.series.map((s) => `${s.label || data.measureLabel} ${full(s.values[i])}`).join(", ")}` }, svg);
      band.__tip = tip(c, data, i, theme, single);
      band.__cross = { el: crosshair, x: sx(i) };
    });
    return plotY + plotH + 28;
  }

  // ---------------------------------------------------------------------------
  // pie / donut: one series, slices in slot order, "Others" gray, legend with values and shares
  function pie(svg, data, opts, theme, top, donut) {
    const { width } = opts;
    const s = data.series[0];
    const cats = data.categories;
    const values = s.values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const r = 120;
    const cx = r + 10;
    const cy = top + r + 16;
    let angle = -Math.PI / 2;
    const colors = cats.map((c, i) => (c.others ? theme.others : theme.series[i % theme.series.length]));
    cats.forEach((c, i) => {
      const v = values[i];
      if (!v) return;
      const a = (v / total) * Math.PI * 2;
      const a2 = angle + a;
      const large = a > Math.PI ? 1 : 0;
      const p = (ang, rad) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
      const ri = donut ? r * 0.6 : 0;
      const d = a >= Math.PI * 2 - 1e-6
        ? (donut ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0M${cx - ri},${cy}a${ri},${ri} 0 1,1 ${2 * ri},0a${ri},${ri} 0 1,1 ${-2 * ri},0Z` : `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`)
        : donut
          ? `M${p(angle, r)}A${r},${r} 0 ${large},1 ${p(a2, r)}L${p(a2, ri)}A${ri},${ri} 0 ${large},0 ${p(angle, ri)}Z`
          : `M${cx},${cy}L${p(angle, r)}A${r},${r} 0 ${large},1 ${p(a2, r)}Z`;
      const mark = el("path", { d, fill: colors[i], stroke: theme.surface, "stroke-width": 2, "stroke-linejoin": "round", class: "mark", tabindex: 0, role: "img", "aria-label": `${c.label}: ${full(s.values[i])} (${Math.round((v / total) * 100)}%)` }, svg);
      mark.__tip = { title: c.label, rows: [{ label: data.measureLabel, value: `${full(s.values[i])} · ${((v / total) * 100).toFixed(1)}%`, color: colors[i] }] };
      // share inside the slice when there is room (white or ink by the fill's luminance)
      if (v / total >= 0.07) {
        const mid = angle + a / 2;
        const rr = donut ? r * 0.8 : r * 0.62;
        const hex = colors[i].replace("#", "");
        const lum = (0.2126 * parseInt(hex.slice(0, 2), 16) + 0.7152 * parseInt(hex.slice(2, 4), 16) + 0.0722 * parseInt(hex.slice(4, 6), 16)) / 255;
        text(svg, cx + rr * Math.cos(mid), cy + rr * Math.sin(mid) + 4, `${Math.round((v / total) * 100)}%`, { fill: lum > 0.6 ? "#0b0b0b" : "#ffffff", "font-size": 11, "font-weight": 600, "text-anchor": "middle" });
      }
      angle = a2;
    });
    if (donut) {
      text(svg, cx, cy - 2, compact(s.values.reduce((a, b) => a + b, 0)), { fill: theme.ink, "font-size": 20, "font-weight": 600, "text-anchor": "middle" });
      text(svg, cx, cy + 16, fit(data.measureLabel, r, 11), { fill: theme.muted, "font-size": 11, "text-anchor": "middle" });
    }
    // legend: swatch, label, value, share
    const lx = cx + r + 40;
    const lw = width - lx;
    let ly = top + 30;
    cats.forEach((c, i) => {
      el("rect", { x: lx, y: ly - 9, width: 10, height: 10, rx: 2, fill: colors[i] }, svg);
      text(svg, lx + 16, ly, fit(c.label, Math.max(60, lw - 150)), { fill: theme.ink2 });
      text(svg, width - 60, ly, full(s.values[i]), { fill: theme.ink, "text-anchor": "end", "font-variant-numeric": "tabular-nums" });
      text(svg, width, ly, `${((values[i] / total) * 100).toFixed(1)}%`, { fill: theme.muted, "text-anchor": "end", "font-variant-numeric": "tabular-nums" });
      ly += 22;
    });
    return Math.max(cy + r + 16, ly);
  }

  /* data: pivot() result + {measureLabel}; opts: {type, width, theme, title, subtitle}. */
  function render(data, opts) {
    const theme = THEMES[opts.theme] || THEMES.light;
    const width = opts.width;
    const svg = el("svg", { xmlns: SVGNS, role: "img", "aria-label": opts.title || "Chart", "font-family": FONT });
    el("rect", { x: -16, y: -16, width: width + 32, height: 10, fill: theme.surface, class: "bg" }, svg);
    const top = title(svg, theme, opts, width);
    let bottom;
    if (!data.categories.length) {
      text(svg, width / 2, top + 60, "No records match.", { fill: theme.muted, "text-anchor": "middle" });
      bottom = top + 100;
    } else if (opts.type === "pie" || opts.type === "donut") bottom = pie(svg, data, { width }, theme, top, opts.type === "donut");
    else if (opts.type === "line") bottom = lines(svg, data, { width }, theme, top);
    else bottom = bars(svg, data, { width }, theme, top, opts.type === "hbar");
    const height = Math.ceil(bottom + 8);
    svg.setAttribute("viewBox", `-16 -16 ${width + 32} ${height + 32}`);
    svg.setAttribute("width", width + 32);
    svg.setAttribute("height", height + 32);
    svg.querySelector(".bg").setAttribute("height", height + 32);
    return { svg, height: height + 32, width: width + 32 };
  }

  // Which form suits the data: dates -> line; split -> stacked columns; few -> pie; else bars.
  function suggest({ categories, split, chronological }) {
    if (chronological) return "line";
    if (split) return categories.length > 8 ? "hbar" : "bar";
    if (categories.length <= 6 && categories.length >= 2) return "pie";
    return categories.length > 8 || categories.some((c) => c.label.length > 14) ? "hbar" : "bar";
  }

  NS.chart = { render, suggest, THEMES, compact, ticks, fit };
})();
