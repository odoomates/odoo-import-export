/* Odoo Import Export: group and total records for charts.
 *
 * Odoo does the grouping: formatted_read_group (Odoo 19) or read_group (16-18), so only
 * the totals travel. When the server can't group by a related field (older versions), the
 * values are exported and grouped in the browser, up to BROWSER_MAX records.
 *
 *   spec = {model, domain, archived, groupby: [{path, field, granularity}], measure: {field, agg}}
 *   group -> {key: {value, label}[], count, value}
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const BROWSER_MAX = 50000;
  const MAX_GROUPS = 5000;
  const NONE = "None";

  const groupSpec = (g) => `${g.path.join(".")}${g.granularity ? `:${g.granularity}` : ""}`;
  const aggSpec = (m) => (m.agg === "count" ? null : `${m.field.name}:${m.agg}`);

  // A group value from Odoo -> {value, label}, using the field for selections and booleans.
  function keyOf(raw, field) {
    if (raw === false || raw === null || raw === undefined || raw === "") return { value: false, label: field && field.type === "boolean" ? "No" : NONE };
    if (Array.isArray(raw)) return { value: raw[0], label: String(raw[1] ?? raw[0]) }; // [id, name] or [start, "March 2024"]
    if (field && field.type === "selection") {
      const hit = (field.selection || []).find(([k]) => k === raw);
      return { value: raw, label: hit ? hit[1] : String(raw) };
    }
    if (field && field.type === "boolean") return { value: !!raw, label: raw ? "Yes" : "No" };
    return { value: raw, label: String(raw) };
  }

  async function serverGroups(client, spec, ctx) {
    const groupby = spec.groupby.map(groupSpec);
    const agg = aggSpec(spec.measure);
    let rows;
    let modern = true;
    try {
      rows = await client.call(spec.model, "formatted_read_group", [spec.domain, groupby, ["__count", ...(agg ? [agg] : [])]], { limit: MAX_GROUPS }, ctx);
    } catch (e) {
      if (!/does not exist|has no attribute|formatted_read_group/i.test(e.message || "")) throw e;
      modern = false;
      // Odoo 16-18: read_group(domain, fields, groupby, offset, limit, orderby, lazy)
      rows = await client.call(spec.model, "read_group", [spec.domain, agg ? [agg] : [], groupby], { limit: MAX_GROUPS, lazy: false }, ctx);
    }
    return rows.map((r) => ({
      key: spec.groupby.map((g, i) => keyOf(r[groupby[i]], g.field)),
      count: r.__count ?? r[`${groupby[0]}_count`] ?? 0,
      value: agg ? Number(r[modern ? agg : spec.measure.field.name]) || 0 : r.__count ?? 0,
      domain: r.__extra_domain || null,
    }));
  }

  // Bucket a date ("2024-03-15" or "2024-03-15 10:00:00") like Odoo's granularities.
  function bucket(text, granularity) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ""));
    if (!m) return { value: false, label: NONE };
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const pad = (n) => String(n).padStart(2, "0");
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    switch (granularity) {
      case "year":
        return { value: `${y}-01-01`, label: String(y) };
      case "quarter": {
        const q = Math.floor((mo - 1) / 3) + 1;
        return { value: `${y}-${pad((q - 1) * 3 + 1)}-01`, label: `Q${q} ${y}` };
      }
      case "week": {
        const date = new Date(Date.UTC(y, mo - 1, d));
        const monday = new Date(date);
        monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
        const thursday = new Date(monday);
        thursday.setUTCDate(monday.getUTCDate() + 3);
        const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
        const week = Math.ceil(((thursday - jan1) / 86400000 + 1) / 7);
        return { value: monday.toISOString().slice(0, 10), label: `W${week} ${thursday.getUTCFullYear()}` };
      }
      case "day":
        return { value: `${y}-${pad(mo)}-${pad(d)}`, label: `${d} ${MONTHS[mo - 1].slice(0, 3)} ${y}` };
      default:
        return { value: `${y}-${pad(mo)}-01`, label: `${MONTHS[mo - 1]} ${y}` };
    }
  }

  // Group in the browser from exported values (related fields on older Odoo versions).
  async function browserGroups(client, spec, ctx, signal) {
    const ids = await client.call(spec.model, "search", [spec.domain], { limit: BROWSER_MAX + 1 }, ctx);
    const truncated = ids.length > BROWSER_MAX;
    const paths = spec.groupby.map((g) => g.path.join("/"));
    if (spec.measure.agg !== "count") paths.push(spec.measure.field.name);
    const groups = new Map();
    for (let i = 0; i < Math.min(ids.length, BROWSER_MAX); i += 2000) {
      NS.rpc.throwIfAborted(signal);
      const res = await client.call(spec.model, "export_data", [ids.slice(i, i + 2000), paths], {}, { ...ctx, import_compat: true });
      for (const row of res.datas) {
        // A record with several tags counts once in each tag's group, like Odoo's grouping.
        const options = spec.groupby.map((g, k) => {
          const raw = row[k];
          if (g.granularity) return [bucket(raw, g.granularity)];
          if (g.field && g.field.type === "many2many" && raw) return String(raw).split(",").map((x) => keyOf(x.trim(), g.field));
          return [keyOf(raw === "" ? false : raw, g.field)];
        });
        const combos = options.reduce((acc, opts) => acc.flatMap((a) => opts.map((o) => [...a, o])), [[]]);
        for (const key of combos) {
          const id = JSON.stringify(key.map((x) => x.value));
          if (!groups.has(id)) groups.set(id, { key, count: 0, values: [] });
          const grp = groups.get(id);
          grp.count++;
          if (spec.measure.agg !== "count") grp.values.push(Number(row[spec.groupby.length]) || 0);
        }
      }
    }
    const reduce = (vals, count) => {
      switch (spec.measure.agg) {
        case "sum":
          return vals.reduce((a, b) => a + b, 0);
        case "avg":
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        case "min":
          return vals.length ? Math.min(...vals) : 0;
        case "max":
          return vals.length ? Math.max(...vals) : 0;
        default:
          return count;
      }
    };
    const out = [...groups.values()].map((g) => ({ key: g.key, count: g.count, value: reduce(g.values, g.count), domain: null }));
    if (spec.groupby.some((g) => g.granularity)) out.sort((a, b) => String(a.key[0].value).localeCompare(String(b.key[0].value)));
    return { groups: out, truncated };
  }

  async function group(client, spec, { signal } = {}) {
    const ctx = spec.archived ? { active_test: false } : {};
    try {
      return { groups: await serverGroups(client, spec, ctx), via: "server", truncated: false };
    } catch (e) {
      if (e.aborted || e.expired) throw e;
      const res = await browserGroups(client, spec, ctx, signal);
      return { ...res, via: "browser" };
    }
  }

  /* Shape groups for a chart: categories (first group-by) and series (second group-by,
   * or one series). Keeps the top `top` categories and `seriesTop` series by total; the
   * rest folds into "Others". Dates keep their order and are never folded.
   * Returns {categories: [{key, label, others}], series: [{key, label, values, others}], total}. */
  function pivot(groups, { top = 10, seriesTop = 7, chronological = false, agg = "count" } = {}) {
    const split = groups.length && groups[0].key.length > 1;
    const catIndex = new Map();
    const serIndex = new Map();
    const cell = new Map(); // `${cat}|${ser}` -> {value, count}
    for (const g of groups) {
      const c = JSON.stringify(g.key[0].value);
      const s = split ? JSON.stringify(g.key[1].value) : "_";
      if (!catIndex.has(c)) catIndex.set(c, { id: c, label: g.key[0].label, total: 0, count: 0, order: catIndex.size });
      if (!serIndex.has(s)) serIndex.set(s, { id: s, label: split ? g.key[1].label : null, total: 0, count: 0 });
      cell.set(`${c}|${s}`, { value: g.value, count: g.count });
      catIndex.get(c).total += g.value;
      catIndex.get(c).count += g.count;
      serIndex.get(s).total += g.value;
      serIndex.get(s).count += g.count;
    }
    // Combine cells for "Others": sums add up, averages are weighted by their record counts.
    const combine = (cells) => {
      const count = cells.reduce((a, x) => a + x.count, 0);
      if (!cells.length) return { value: 0, count: 0 };
      if (agg === "avg") return { value: count ? cells.reduce((a, x) => a + x.value * x.count, 0) / count : 0, count };
      if (agg === "min") return { value: Math.min(...cells.map((x) => x.value)), count };
      if (agg === "max") return { value: Math.max(...cells.map((x) => x.value)), count };
      return { value: cells.reduce((a, x) => a + x.value, 0), count };
    };

    let cats = [...catIndex.values()];
    if (!chronological) cats.sort((a, b) => b.total - a.total || a.order - b.order);
    let folded = [];
    if (!chronological && cats.length > top) {
      folded = cats.slice(top);
      cats = cats.slice(0, top);
    }
    let sers = [...serIndex.values()].sort((a, b) => b.total - a.total);
    let foldedSer = [];
    if (sers.length > seriesTop + 1) {
      foldedSer = sers.slice(seriesTop);
      sers = sers.slice(0, seriesTop);
    }
    const valueAt = (catIds, serIds) => {
      const cells = [];
      for (const c of catIds) for (const s of serIds) if (cell.has(`${c}|${s}`)) cells.push(cell.get(`${c}|${s}`));
      return combine(cells).value;
    };
    const catGroups = [...cats.map((c) => ({ key: c.id, label: c.label, ids: [c.id], others: false }))];
    if (folded.length) catGroups.push({ key: "__others", label: `Others (${folded.length})`, ids: folded.map((c) => c.id), others: true });
    const serGroups = sers.map((s) => ({ key: s.id, label: s.label, ids: [s.id], others: false }));
    if (foldedSer.length) serGroups.push({ key: "__others", label: `Others (${foldedSer.length})`, ids: foldedSer.map((s) => s.id), others: true });
    const series = serGroups.map((s) => ({ key: s.key, label: s.label, others: s.others, values: catGroups.map((c) => valueAt(c.ids, s.ids)) }));
    const total = combine([...cell.values()]).value;
    return { categories: catGroups.map(({ ids, ...c }) => c), series, total, split };
  }

  /* Comparison of two periods. Categories are the union of both, ranked by their combined value,
   * so a customer who only bought in the earlier period still counts; the rest folds into
   * "Others" for both. Dates are matched by position instead (October vs September).
   * Returns a pivot-like {categories, series: [current, previous], compare: true}. */
  function compare(curGroups, prevGroups, { top = 10, chronological = false, agg = "count", labels = ["This period", "Previous"] } = {}) {
    if (chronological) {
      const cur = pivot(curGroups, { chronological: true, agg });
      const prev = pivot(prevGroups, { chronological: true, agg });
      const pv = prev.series[0] ? prev.series[0].values : [];
      return {
        categories: cur.categories.map((c, i) => ({ ...c, label: prev.categories[i] ? `${c.label} vs ${prev.categories[i].label}` : c.label })),
        series: [
          { key: "current", label: labels[0], others: false, values: cur.series[0] ? cur.series[0].values : [] },
          { key: "previous", label: labels[1], others: false, compare: true, values: cur.categories.map((_, i) => pv[i] ?? 0) },
        ],
        total: cur.total,
        split: false,
        compare: true,
      };
    }
    // Both periods as a second grouping of one pivot: same ranking, same "Others".
    const tag = (groups, period) => groups.map((g) => ({ ...g, key: [g.key[0], { value: period, label: period }] }));
    const both = pivot([...tag(curGroups, "current"), ...tag(prevGroups, "previous")], { top, seriesTop: 2, agg });
    const pick = (period) => both.series.find((x) => x.key === JSON.stringify(period));
    const zeros = both.categories.map(() => 0);
    return {
      categories: both.categories,
      series: [
        { key: "current", label: labels[0], others: false, values: (pick("current") || { values: zeros }).values },
        { key: "previous", label: labels[1], others: false, compare: true, values: (pick("previous") || { values: zeros }).values },
      ],
      total: (pick("current") || { values: zeros }).values.reduce((a, b) => a + b, 0),
      split: false,
      compare: true,
    };
  }

  NS.analyze = { compare, group, pivot, keyOf, bucket, groupSpec };
})();
