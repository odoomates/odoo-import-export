/* Odoo Import Export: stock counts (stock.quant).
 *
 * Odoo's own import never looks for the quant a row stands for: with import_file in the
 * context, stock.quant.create() skips _gather() ("merge quants later"), so a row without a
 * database id makes a second quant next to the one in stock. A count import matches the rows
 * to quants here, by product, location, lot, package and owner, and sends the matched ones with
 * their ".id": Odoo then only writes the counted quantity (inventory_quantity). A row without a
 * quant creates one, which is right: there is none.
 *
 * The import applies nothing. The counts wait in Inventory > Physical Inventory (filter To Apply),
 * where the user reviews the differences and applies them (Odoo makes the moves then), or the
 * user applies them from the panel afterwards (apply). Undo restores the counts not applied yet.
 *
 * Modes (job.count.mode):
 *   listed     the rows' quants get their counted quantity; nothing else changes
 *   overwrite  same, and every other quant of the sheet's locations is counted 0
 *   add        counted = on hand + the sheet's quantity
 *   default    Odoo's import as for any model (plan.js / execute.js)
 *
 * Works the same on Odoo 18 to 20: the package model (stock.quant.package / stock.package) comes
 * from the field's relation, and only fields every version has are written.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  const MODEL = "stock.quant";
  const MODES = [
    { id: "listed", label: "Update listed items only", text: "Each row sets the counted quantity of its product (and lot) in its location. Everything not in the sheet stays as it is." },
    { id: "overwrite", label: "Overwrite location", text: "A full count: the rows set their counted quantity, and everything else in the sheet's locations is counted 0." },
    { id: "add", label: "Add to on hand", text: "Counted = on hand + the sheet's quantity, for stock that arrived without being received." },
    { id: "default", label: "Odoo default", text: "Odoo's own import: rows with an ID update their quant, rows without one create a new quant." },
  ];
  // Counts are offered on the releases they're tested on only; elsewhere (other majors, Odoo
  // Online's intermediate saas~ releases) stock.quant gets Odoo's own import like any model.
  const TESTED = [18, 19, 20];
  const tested = (version) => !!version && TESTED.includes(version.major) && version.minor === 0;
  const QTY_FIELDS = ["inventory_quantity", "inventory_quantity_auto_apply"];
  const DIMS = { product_id: "product", location_id: "location", lot_id: "lot", package_id: "package", owner_id: "owner" };
  const EPS = 1e-6;

  const idOf = (v) => (Array.isArray(v) ? v[0] : v || 0);
  const nameOf = (v) => (Array.isArray(v) ? v[1] : "");
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const uniq = (list) => [...new Set(list.filter(Boolean))];

  // A count import into stock.quant (not Odoo's default flow)?
  function active(job) {
    return !!(job && job.model === MODEL && job.count && job.count.mode !== "default");
  }

  // The count settings of a stock.quant job, made on first use.
  function ensure(job) {
    if (job && job.model === MODEL && !job.count) job.count = { mode: "listed", sublocations: false };
    return job && job.count;
  }

  /* Switch modes. A count matches rows to quants itself: the generic record key is put aside
   * (and given back for Odoo's default flow). Call it again after pipeline.resolve, which may
   * pick a key. Returns true when the key came back (its records must be looked up again). */
  function setMode(job, mode) {
    ensure(job);
    job.count.mode = mode;
    if (mode === "default") {
      const loc = job.defaults.get("location_id");
      if (loc && loc.auto) job.defaults.delete("location_id");
      const back = job.count.key || null;
      if (back) job.key = back;
      job.count.key = null;
      return !!back;
    }
    const sole = job.count.sole;
    if (sole && !job.defaults.has("location_id")) job.defaults.set("location_id", soleDefault(sole));
    if (job.key) {
      job.count.key = job.key;
      job.key = null;
      job.existing = new Map();
    }
    return false;
  }

  // The location filled in for every row without one (soleLocation), as a job default.
  const soleDefault = (sole) => ({ out: String(sole.id), label: sole.label, path: "location_id/.id", auto: true, why: sole.why });

  // The columns a count reads: col index or null.
  function columns(job) {
    const out = { product: null, location: null, lot: null, package: null, owner: null, qty: null, lotByName: false };
    for (const m of NS.plan.active(job)) {
      if (NS.plan.isSub(m)) continue;
      const top = m.path[0];
      if (DIMS[top] && job.rel.has(m.col)) out[DIMS[top]] = m.col;
      else if (QTY_FIELDS.includes(top) && (out.qty === null || top === "inventory_quantity")) out.qty = m.col;
    }
    // Lot names are unique per product only: looked up here, with the row's product.
    out.lotByName = out.lot !== null && job.rel.get(out.lot).mode === "name";
    return out;
  }

  // Columns the generic matching leaves to this module (no conflicts raised for them).
  function ownCols(job) {
    if (!active(job)) return new Set();
    const c = columns(job);
    return c.lotByName ? new Set([c.lot]) : new Set();
  }

  // What keeps a count from being planned at all: [messages].
  function problems(job) {
    const c = columns(job);
    const out = [];
    if (c.product === null) out.push("Map a column to Product.");
    if (c.qty === null) out.push("Map a column to Counted Quantity.");
    if (c.location === null && !job.defaults.has("location_id")) out.push("Map a column to Location, or set one location for every row (Review step).");
    return out;
  }

  // The record a relational cell stands for: an id, "create" (to create), or null.
  function linked(job, analysis, col, i) {
    const raw = String(job.table.rows[i][col] ?? "").trim();
    if (!raw) return null;
    const k = lower(raw);
    const at = `${col}:${i}:${k}`;
    if (analysis.rowId.has(at)) return analysis.rowId.get(at) || null;
    const d = job.decisions.get(`m2o:${col}:${k}`);
    if (d) return d.action === "pick" ? d.id : d.action === "create" ? "create" : null;
    const r = (job.resolutions.get(col) || new Map()).get(raw);
    return r && (r.status === "ok" || r.status === "archived") ? r.id : null;
  }

  // The counted quantity of a row: a number, null (empty cell) or NaN.
  function quantity(job, analysis, m, i) {
    const raw = String(job.table.rows[i][m.col] ?? "").trim();
    if (!raw) return null;
    const field = m.fields[m.fields.length - 1];
    const d = job.decisions.get(`value:${m.col}:${lower(raw)}`);
    let r;
    if (d && d.action === "empty") return null;
    if (d && d.action === "value") r = NS.values.convert(field, d.value, job.profiles[m.col]);
    else r = (analysis.conv.get(m.col) && analysis.conv.get(m.col).get(raw)) || NS.values.convert(field, raw, job.profiles[m.col]);
    return r && r.ok && r.out !== "" ? Number(r.out) : NaN;
  }

  /* The sheet's rows as count entries: {entries: [{row, product, location, lot, lotName,
   * package, owner, qty}], errors: [{row, line, message}], blank: [rows without a quantity]}. */
  function readRows(job, analysis) {
    const c = columns(job);
    const qtyMap = NS.plan.active(job).find((m) => m.col === c.qty);
    const fallback = job.defaults.get("location_id");
    const entries = [];
    const errors = [];
    const blank = [];
    const cell = (col, i) => (col === null ? "" : String(job.table.rows[i][col] ?? "").trim());
    for (const i of analysis.starts) {
      if (analysis.skipRows.has(i)) continue;
      const err = (message) => errors.push({ row: i, line: job.table.lines[i], message });
      const qty = qtyMap ? quantity(job, analysis, qtyMap, i) : null;
      if (qty === null) {
        blank.push(i);
        continue;
      }
      if (Number.isNaN(qty)) {
        err(`“${cell(c.qty, i)}” isn't a quantity.`);
        continue;
      }
      if (qty < 0) {
        err(`The counted quantity ${qty} is negative.`);
        continue;
      }
      const product = c.product === null ? null : linked(job, analysis, c.product, i);
      if (!product) {
        err(cell(c.product, i) ? `Product “${cell(c.product, i)}” isn't settled.` : "No product.");
        continue;
      }
      let location = c.location === null ? null : linked(job, analysis, c.location, i);
      if (!location && !cell(c.location, i) && fallback) location = Number(fallback.out);
      if (!location) {
        err(cell(c.location, i) ? `Location “${cell(c.location, i)}” isn't settled.` : "No location.");
        continue;
      }
      const pkg = c.package === null ? null : linked(job, analysis, c.package, i);
      const owner = c.owner === null ? null : linked(job, analysis, c.owner, i);
      if ([product, location, pkg, owner].includes("create")) {
        err("A count only links to existing products, locations, packages and owners: pick one, or create it in Odoo first.");
        continue;
      }
      if ((cell(c.package, i) && !pkg) || (cell(c.owner, i) && !owner)) {
        err(`${cell(c.package, i) && !pkg ? `Package “${cell(c.package, i)}”` : `Owner “${cell(c.owner, i)}”`} isn't settled.`);
        continue;
      }
      let lot = null;
      let lotName = "";
      if (c.lotByName) lotName = cell(c.lot, i);
      else if (c.lot !== null) {
        lot = linked(job, analysis, c.lot, i);
        if (cell(c.lot, i) && (!lot || lot === "create")) {
          err(`Lot/Serial “${cell(c.lot, i)}” isn't settled.`);
          continue;
        }
      }
      entries.push({ row: i, product, location, lot, lotName, lotText: cell(c.lot, i), package: pkg || null, owner: owner || null, qty });
    }
    return { entries, errors, blank };
  }

  /* The count, planned from plain data (no Odoo calls: tested as is).
   *   entries: readRows().entries; products: Map id -> {label, tracking, storable};
   *   locations: Map id -> {label, usage, company}; lots: [{id, name, product_id}];
   *   quants: stock.quant rows (search_read) of the scope; has: {lot, package, owner} columns mapped.
   * Returns {mode, lines, zeros, errors, warnings, newLots, stats}: a line is one quant to count
   * (quant null: to create), with the rows it comes from, on hand, counted and the other quants
   * of the same key (an earlier import's duplicates), which are counted 0 so the total is right. */
  function compute({ mode, entries, errors = [], blank = [], products, locations, lots = [], quants, has, lines: sheetLines = [] }) {
    errors = [...errors];
    const warnings = [];
    const warn = (rows, title, message) => warnings.push({ rows, lines: rows.map((r) => sheetLines[r]).filter((x) => x !== undefined), title, message });
    const key = (p, l, lot, pkg, o) => `${p}:${l}:${lot || 0}:${pkg || 0}:${o || 0}`;
    const qKey = (q) => key(idOf(q.product_id), idOf(q.location_id), idOf(q.lot_id), idOf(q.package_id), idOf(q.owner_id));
    // The key on the mapped columns only: quants a row can't tell apart by the sheet's columns.
    const mappedKey = (p, l, lot, pkg, o) => key(p, l, has.lot ? lot : 0, has.package ? pkg : 0, has.owner ? o : 0);
    const byKey = new Map();
    for (const q of quants) {
      const k = qKey(q);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(q);
    }
    const lotIndex = new Map(); // `${product}:${name}` -> id (exact), `${product}:~${lower}` -> [ids]
    for (const l of lots) {
      const p = idOf(l.product_id);
      lotIndex.set(`${p}:${l.name}`, l.id);
      const k = `${p}:~${lower(l.name)}`;
      lotIndex.set(k, [...(lotIndex.get(k) || []), l.id]);
    }
    const lotName = new Map(lots.map((l) => [l.id, l.name]));
    for (const q of quants) if (q.lot_id) lotName.set(idOf(q.lot_id), nameOf(q.lot_id));

    const out = new Map();
    const newLots = new Map();
    for (const e of entries) {
      const p = products.get(e.product);
      const loc = locations.get(e.location);
      const err = (message) => errors.push({ row: e.row, line: sheetLines[e.row], message });
      if (!p) {
        err("The product wasn't found.");
        continue;
      }
      if (!p.storable) {
        err(`${p.label} isn't tracked in stock (a consumable or a service): it can't be counted.`);
        continue;
      }
      if (!loc) {
        err("The location wasn't found.");
        continue;
      }
      if (loc.usage !== "internal" && loc.usage !== "transit") {
        err(`${loc.label} isn't an internal location: stock is counted in internal (or transit) locations only.`);
        continue;
      }
      // A lot on a product without lots, or none on a tracked one: most likely a wrong row or a
      // shifted column, so the row waits (fix the file, or leave it out). A tracked product counted
      // 0 without a lot is fine: that clears stock kept from before the product had lots.
      if (p.tracking === "none" && (e.lotName || e.lot)) {
        err(`${p.label} has no lots or serial numbers, but the row gives “${e.lotText || e.lotName || lotName.get(e.lot) || e.lot}”. Clear the lot in the file, or leave the row out.`);
        continue;
      }
      let lot = e.lot || null;
      let fresh = "";
      if (e.lotName) {
        lot = lotIndex.get(`${e.product}:${e.lotName}`) || null;
        const loose = lotIndex.get(`${e.product}:~${lower(e.lotName)}`) || [];
        if (!lot && loose.length === 1) lot = loose[0];
        if (!lot) fresh = e.lotName;
      }
      if (!lot && !fresh && p.tracking !== "none" && e.qty > EPS) {
        const by = p.tracking === "serial" ? "serial numbers" : "lots";
        err(has.lot
          ? `${p.label} is tracked by ${by}: the row has no lot/serial. Add it to the file, or leave the row out.`
          : `${p.label} is tracked by ${by}, and the sheet has no Lot/Serial column: map one, or leave these rows out.`);
        continue;
      }
      const k = fresh ? `${key(e.product, e.location, 0, e.package, e.owner)}:new:${lower(fresh)}` : key(e.product, e.location, lot, e.package, e.owner);
      if (fresh && !newLots.has(`${e.product}:${lower(fresh)}`)) newLots.set(`${e.product}:${lower(fresh)}`, { name: fresh, product: e.product, company: loc.company || null });
      if (!out.has(k)) {
        out.set(k, {
          key: k, product: e.product, productLabel: p.label, tracking: p.tracking, location: e.location, locationLabel: loc.label,
          lot, lotLabel: fresh || (lot ? lotName.get(lot) || "" : ""), newLot: fresh || null, package: e.package, owner: e.owner,
          rows: [], sheet: 0,
        });
      }
      const line = out.get(k);
      line.rows.push(e.row);
      line.sheet = round(line.sheet + e.qty);
    }

    const lines = [...out.values()];
    const matched = new Set();
    for (const l of lines) {
      // The quant holding the stock gets the count; empty extra ones are left to Odoo's cleanup.
      const qs = (l.newLot ? [] : byKey.get(key(l.product, l.location, l.lot, l.package, l.owner)) || []).slice()
        .sort((a, b) => Math.abs(b.quantity || 0) - Math.abs(a.quantity || 0) || a.id - b.id);
      l.quant = qs[0] || null;
      l.others = qs.slice(1).filter((q) => Math.abs(q.quantity || 0) > EPS || q.inventory_quantity_set);
      for (const q of qs) matched.add(q.id);
      l.onHand = round(qs.reduce((s, q) => s + (q.quantity || 0), 0));
      l.reserved = round(qs.reduce((s, q) => s + (q.reserved_quantity || 0), 0));
      l.counted = mode === "add" ? round(l.onHand + l.sheet) : l.sheet;
      l.diff = round(l.counted - l.onHand);
      l.action = l.quant ? "update" : "create";
      const what = `${l.productLabel}${l.lotLabel ? ` (${l.lotLabel})` : ""} in ${l.locationLabel}`;
      if (l.rows.length > 1) warn(l.rows, `${l.rows.length} rows for ${what}`, `Their quantities are added up: ${l.sheet}.`);
      if (l.others.length) warn(l.rows, `${what} is split over ${l.others.length + 1} quants`, "An earlier import made extra quants for it: the first one gets the count, the others are counted 0, so the total is right once applied.");
      if (l.tracking === "serial" && l.counted > 1 + EPS) warn(l.rows, `Serial number product counted ${l.counted}`, `${what}: a serial number stands for one unit. Odoo will flag it when you apply.`);
      if (l.reserved > EPS && l.counted + EPS < l.reserved) warn(l.rows, `${what}: counted below the reserved quantity`, `${l.reserved} are reserved for transfers; applying ${l.counted} leaves them short.`);
      const set = qs.find((q) => q.inventory_quantity_set);
      if (set) warn(l.rows, `${what} already had a count`, `Counted ${set.inventory_quantity}${set.user_id ? ` by ${nameOf(set.user_id)}` : ""}, not applied yet: this count replaces it.`);
    }

    // Stock the sheet's columns can't tell apart from a row (in a package, of an owner, in a
    // lot, when that column isn't in the sheet): not counted, kept as it is.
    const rowKeys = new Set(lines.map((l) => mappedKey(l.product, l.location, l.lot, l.package, l.owner)));
    const kept = new Map(); // label -> [quants]
    const isKept = (q) => !matched.has(q.id) && rowKeys.has(mappedKey(idOf(q.product_id), idOf(q.location_id), idOf(q.lot_id), idOf(q.package_id), idOf(q.owner_id)));
    for (const q of quants) {
      if (!isKept(q) || Math.abs(q.quantity || 0) < EPS) continue;
      const what = `${nameOf(q.product_id)} in ${nameOf(q.location_id)}`;
      kept.set(what, [...(kept.get(what) || []), q]);
    }
    for (const [what, qs] of kept) {
      const why = [!has.lot && qs.some((q) => q.lot_id) ? "lots" : null, !has.package && qs.some((q) => q.package_id) ? "packages" : null, !has.owner && qs.some((q) => q.owner_id) ? "other owners" : null].filter(Boolean);
      warn([], `${what}: ${qs.reduce((s, q) => s + q.quantity, 0)} more not counted`, `That stock is in ${why.join(", ") || "other quants"}, which the sheet has no column for: it keeps its quantity.`);
    }

    const zeros = [];
    if (mode === "overwrite") {
      for (const q of quants) {
        if (matched.has(q.id) || isKept(q)) continue;
        if (Math.abs(q.quantity || 0) < EPS && !q.inventory_quantity_set) continue;
        const z = {
          key: `zero:${q.id}`, quant: q, others: [], product: idOf(q.product_id), productLabel: nameOf(q.product_id), location: idOf(q.location_id), locationLabel: nameOf(q.location_id),
          lot: idOf(q.lot_id) || null, lotLabel: nameOf(q.lot_id), package: idOf(q.package_id) || null, owner: idOf(q.owner_id) || null,
          rows: [], sheet: 0, onHand: round(q.quantity || 0), reserved: round(q.reserved_quantity || 0), counted: 0, diff: round(-(q.quantity || 0)), action: "zero",
        };
        zeros.push(z);
        if (z.reserved > EPS) warn([], `${z.productLabel} in ${z.locationLabel} is reserved`, `Not in the sheet, so counted 0, but ${z.reserved} are reserved for transfers.`);
      }
    }

    const all = [...lines, ...zeros];
    const extra = lines.reduce((s, l) => s + l.others.length, 0);
    const stats = {
      total: all.length + extra, // counts to set
      rows: entries.length,
      blank: blank.length,
      errors: errors.length,
      update: lines.filter((l) => l.action === "update").length,
      create: lines.filter((l) => l.action === "create").length,
      zero: zeros.length + extra,
      up: all.filter((l) => l.diff > EPS).length,
      down: all.filter((l) => l.diff < -EPS).length,
      same: all.filter((l) => Math.abs(l.diff) <= EPS).length,
      net: round(all.reduce((s, l) => s + l.diff, 0)),
      newLots: newLots.size,
    };
    if (blank.length) warn(blank, `${blank.length} row${blank.length > 1 ? "s have" : " has"} no counted quantity`, "Left out: their stock isn't touched. Put 0 for what isn't there anymore.");
    return { mode, lines, zeros, errors, warnings, newLots: [...newLots.values()], stats };
  }

  // ---------------------------------------------------------------------------
  // Odoo side

  const QUANT_FIELDS = ["product_id", "location_id", "lot_id", "package_id", "owner_id", "quantity", "reserved_quantity", "inventory_quantity", "inventory_quantity_set", "user_id", "company_id"];

  async function readQuants(client, domain) {
    return client.call(MODEL, "search_read", [[["location_id.usage", "in", ["internal", "transit"]], ...domain], QUANT_FIELDS], { order: "id" });
  }

  // Read what a count needs from Odoo and plan it. deps: {client, schemas, onProgress, signal}.
  async function prepare(deps, job, analysis) {
    const { client, schemas } = deps;
    const progress = (t) => deps.onProgress && deps.onProgress(t);
    const c = columns(job);
    const { entries, errors, blank } = readRows(job, analysis);
    const productIds = uniq(entries.map((e) => e.product));
    const locationIds = uniq(entries.map((e) => e.location));
    progress("Reading products and locations…");
    const pSchema = await schemas.load("product.product");
    const pFields = ["display_name", "tracking", "is_storable", "type"].filter((f) => pSchema.fields.has(f));
    const products = new Map();
    for (const p of productIds.length ? await client.call("product.product", "read", [productIds, pFields], {}, { active_test: false }) : []) {
      // is_storable since Odoo 18; "product" type before.
      products.set(p.id, { label: p.display_name, tracking: p.tracking || "none", storable: "is_storable" in p ? !!p.is_storable : p.type === "product" });
    }
    const locations = new Map();
    for (const l of locationIds.length ? await client.call("stock.location", "read", [locationIds, ["display_name", "usage", "company_id"]], {}, { active_test: false }) : []) {
      locations.set(l.id, { label: l.display_name, usage: l.usage, company: idOf(l.company_id) || null });
    }
    const names = uniq(entries.map((e) => e.lotName));
    let lots = [];
    if (names.length) {
      progress("Looking up lots…");
      for (let i = 0; i < names.length; i += 500) {
        const part = names.slice(i, i + 500);
        const variants = uniq(part.flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()]));
        lots = lots.concat(await client.call("stock.lot", "search_read", [[["product_id", "in", productIds], ["name", "in", variants]], ["name", "product_id"]], {}, { active_test: false }));
      }
    }
    NS.rpc.throwIfAborted(deps.signal);
    progress("Reading the stock…");
    const mode = job.count.mode;
    let quants = [];
    if (locationIds.length) {
      quants = mode === "overwrite"
        ? await readQuants(client, [["location_id", job.count.sublocations ? "child_of" : "in", locationIds]])
        : productIds.length ? await readQuants(client, [["product_id", "in", productIds], ["location_id", "in", locationIds]]) : [];
    }
    const has = { lot: c.lot !== null, package: c.package !== null, owner: c.owner !== null };
    const plan = compute({ mode, entries, errors, blank, products, locations, lots, quants, has, lines: job.table.lines });
    plan.locations = locationIds.map((id) => locations.get(id)).filter(Boolean).map((l) => l.label);
    plan.sublocations = !!job.count.sublocations;
    plan.sheetLines = job.table.lines;
    return plan;
  }

  /* The location every row can be counted in when the sheet doesn't say: the only internal
   * location the user sees, or (without Storage Locations) the one warehouse's stock location,
   * which is what Odoo's Physical Inventory uses then. {id, label, why} or null. */
  async function soleLocation(client, uid) {
    const locs = await client.call("stock.location", "search_read", [[["usage", "=", "internal"]], ["display_name"]], { limit: 2 });
    if (locs.length === 1) return { id: locs[0].id, label: locs[0].display_name, why: "the only stock location" };
    if (!locs.length || !uid) return null;
    const multi = await client.call("res.users", "has_group", [[uid], "stock.group_stock_multi_locations"]).catch(() => true);
    if (multi) return null;
    const whs = await client.call("stock.warehouse", "search_read", [[], ["lot_stock_id"]], { limit: 2 });
    if (whs.length !== 1 || !whs[0].lot_stock_id) return null;
    return { id: idOf(whs[0].lot_stock_id), label: nameOf(whs[0].lot_stock_id), why: "the warehouse's stock location" };
  }

  const num = (n) => String(round(n));

  /* Set the counted quantities (or check them: dryrun). executor: execute.createExecutor().
   * Returns the executor's result shape, created: [] (quants are never deleted by undo) and
   * count: {mode, prev: [{id, set, qty, user}], created: [quant ids], zeroed}. */
  async function run(client, executor, plan, { dryrun = false, batchSize = 500, signal, onProgress, context = {}, uid = null } = {}) {
    const result = { ok: true, dryrun, created: [], updated: [], deps: [], createdRecords: [], errors: [], warnings: [], batchesDone: 0, noDryRun: false, count: null };
    const count = { mode: plan.mode, prev: [], created: [], zeroed: 0, lines: plan.lines.length };
    const lotIds = new Map();
    if (plan.newLots.length && !dryrun) {
      try {
        const vals = plan.newLots.map((l) => ({ name: l.name, product_id: l.product, ...(l.company ? { company_id: l.company } : {}) }));
        const ids = await client.call("stock.lot", "create", [vals]);
        plan.newLots.forEach((l, k) => {
          lotIds.set(`${l.product}:${lower(l.name)}`, ids[k]);
          result.createdRecords.push({ relation: "stock.lot", name: l.name, id: ids[k] });
        });
        result.deps.push({ relation: "stock.lot", ids });
      } catch (e) {
        result.ok = false;
        result.errors.push({ row: null, line: null, message: `Couldn't create the new lots: ${e.message}` });
        return result;
      }
    }
    const what = (l) => `${l.productLabel}${l.lotLabel ? ` (${l.lotLabel})` : ""} in ${l.locationLabel}`;
    const user = uid ? [String(uid)] : [];
    const userField = uid ? ["user_id/.id"] : [];
    const items = []; // {line, quant, counted, part}
    for (const l of [...plan.lines, ...plan.zeros]) {
      if (l.quant) items.push({ line: l, quant: l.quant, counted: l.counted, part: "update" });
      else items.push({ line: l, quant: null, counted: l.counted, part: "create" });
      for (const q of l.others || []) items.push({ line: l, quant: q, counted: 0, part: "update", extra: true });
    }
    const updates = items.filter((x) => x.part === "update");
    const creates = items.filter((x) => x.part === "create");
    const dims = [["lot_id", (l) => l.lot || (l.newLot ? lotIds.get(`${l.product}:${lower(l.newLot)}`) : null)], ["package_id", (l) => l.package], ["owner_id", (l) => l.owner]]
      .filter(([, get]) => creates.some((x) => get(x.line)));
    const steps = [
      { part: "update", list: updates, fields: [".id", "inventory_quantity", ...userField], row: (x) => [String(x.quant.id), num(x.counted), ...user] },
      {
        part: "create", list: creates,
        fields: ["product_id/.id", "location_id/.id", ...dims.map(([f]) => `${f}/.id`), "inventory_quantity", ...userField],
        row: (x) => [String(x.line.product), String(x.line.location), ...dims.map(([, get]) => (get(x.line) ? String(get(x.line)) : "")), num(x.counted), ...user],
      },
    ];
    const total = items.length;
    let done = 0;
    for (const step of steps) {
      for (let i = 0; i < step.list.length; i += batchSize) {
        if (signal && signal.aborted) {
          result.ok = false;
          result.cancelled = true;
          break;
        }
        if (onProgress) onProgress({ phase: dryrun ? "check" : "import", done, total });
        const part = step.list.slice(i, i + batchSize);
        let res;
        try {
          res = await executor.batch(MODEL, { fields: step.fields, columns: step.fields }, part.map(step.row), dryrun, context);
        } catch (e) {
          result.ok = false;
          const row = part[0].line.rows[0] ?? null;
          result.errors.push({ row, line: row === null ? null : (plan.sheetLines || [])[row] ?? null, message: e.message, title: e.title });
          break;
        }
        if (res.noDryRun) {
          result.noDryRun = true;
          return result;
        }
        let failed = false;
        for (const msg of res.messages || []) {
          const at = msg.rows ? msg.rows.from : typeof msg.record === "number" ? msg.record : null;
          const x = at !== null && at !== undefined ? part[at] : null;
          const row = x && x.line.rows.length ? x.line.rows[0] : null;
          const entry = { row, line: row === null ? null : (plan.sheetLines || [])[row] ?? null, message: x && row === null ? `${what(x.line)}: ${msg.message}` : msg.message, field: msg.field_name || msg.field || null };
          if (msg.type === "error") {
            failed = true;
            result.errors.push(entry);
          } else result.warnings.push(entry);
        }
        if (failed || !res.ids) {
          result.ok = false;
          if (!dryrun) break;
        } else if (!dryrun) {
          part.forEach((x, k) => {
            const id = res.ids[k];
            if (!id) return;
            if (x.part === "update") {
              result.updated.push(id);
              count.prev.push({ id, set: !!x.quant.inventory_quantity_set, qty: x.quant.inventory_quantity || 0, user: idOf(x.quant.user_id) || null });
              if (x.line.action === "zero" || x.extra) count.zeroed++;
            } else count.created.push(id);
          });
        }
        done += part.length;
        result.batchesDone++;
      }
      if (!result.ok && !dryrun) break;
    }
    result.count = count;
    if (onProgress) onProgress({ phase: "done", done, total });
    return result;
  }

  /* Undo a count: the counts not applied yet go back to what they were (cleared, or the earlier
   * count); quants the count created are cleared, and Odoo drops them (empty quants are removed
   * when the inventory is opened). Counts applied meanwhile stay: they have moves now. */
  async function undo(client, entry) {
    const errors = [];
    const c = entry.count;
    const ids = [...c.prev.map((p) => p.id), ...c.created];
    try {
      const rows = ids.length ? await client.call(MODEL, "search_read", [[["id", "in", ids]], ["inventory_quantity_set"]]) : [];
      const pending = new Set(rows.filter((r) => r.inventory_quantity_set).map((r) => r.id));
      const clear = [...c.created, ...c.prev.filter((p) => !p.set).map((p) => p.id)].filter((id) => pending.has(id));
      if (clear.length) await client.call(MODEL, "action_clear_inventory_quantity", [clear]);
      const restore = new Map(); // `${qty}:${user}` -> ids
      for (const p of c.prev) {
        if (!p.set || !pending.has(p.id)) continue;
        const k = `${p.qty}:${p.user || 0}`;
        restore.set(k, [...(restore.get(k) || []), p.id]);
      }
      for (const [k, list] of restore) {
        const [qty, user] = k.split(":").map(Number);
        await client.call(MODEL, "write", [list, { inventory_quantity: qty, user_id: user || false }]);
      }
      const applied = ids.length - pending.size;
      if (applied) errors.push(`${applied} count${applied > 1 ? "s were" : " was"} already applied in Odoo and can't be undone here.`);
      // The cleared new quants go when Odoo tidies its quants, as opening Physical Inventory
      // does (empty quants are removed); only then can the new lots be deleted.
      if (c.created.length) await client.call(MODEL, "action_view_inventory", []).catch(() => null);
    } catch (e) {
      errors.push(e.message);
    }
    // New lots still in use (a count applied meanwhile) stay: empty, they do no harm.
    for (const d of [...(entry.deps || [])].reverse()) await client.call(d.relation, "unlink", [d.ids]).catch(() => null);
    return errors;
  }

  /* Apply the counts of an import (entry.count), as Odoo's Apply button does: stock moves to or
   * from the inventory loss location, referenced `reason`. Only the counts still waiting are
   * applied (not those applied or cleared in Odoo meanwhile). A quant whose stock moved since the
   * count is left for review: Odoo would answer with its conflict wizard, and apply nothing.
   * Returns {applied, outdated, gone, errors, cancelled}. */
  async function apply(client, entry, { reason = "", batchSize = 500, signal, onProgress } = {}) {
    const c = entry.count;
    const ids = [...c.prev.map((p) => p.id), ...c.created];
    const out = { applied: [], outdated: [], gone: 0, errors: [], cancelled: false };
    let rows;
    try {
      rows = ids.length ? await client.call(MODEL, "search_read", [[["id", "in", ids]], ["inventory_quantity_set", "is_outdated"]]) : [];
    } catch (e) {
      out.errors.push(e.message);
      return out;
    }
    const pending = rows.filter((r) => r.inventory_quantity_set);
    out.gone = ids.length - pending.length;
    out.outdated = pending.filter((r) => r.is_outdated).map((r) => r.id);
    const todo = pending.filter((r) => !r.is_outdated).map((r) => r.id);
    const context = reason ? { inventory_name: reason } : {};
    for (let i = 0; i < todo.length; i += batchSize) {
      if (signal && signal.aborted) {
        out.cancelled = true;
        break;
      }
      if (onProgress) onProgress({ phase: "apply", done: i, total: todo.length });
      const part = todo.slice(i, i + batchSize);
      try {
        // An action back is the conflict wizard (stock moved in between): nothing was applied.
        const res = await client.call(MODEL, "action_apply_inventory", [part], {}, context);
        if (res && typeof res === "object" && res.res_model) out.outdated.push(...part);
        else out.applied.push(...part);
      } catch (e) {
        out.errors.push(e.message);
        break;
      }
    }
    if (onProgress) onProgress({ phase: "done", done: out.applied.length, total: todo.length });
    return out;
  }

  /* A count sheet: what is in stock in these locations, with an empty Counted Quantity column
   * to fill in and import back. Returns {fileName, sheets}. */
  async function countSheet(client, { locations, sublocations = false, label = "" }) {
    // One row per product, lot, location, package and owner: Odoo can hold that stock in several
    // quants (an earlier import, or a move that didn't merge), and a row per quant would make the
    // counter count it twice (rows of the same key are added up on import).
    const merged = new Map();
    for (const q of await readQuants(client, [["location_id", sublocations ? "child_of" : "in", locations]])) {
      const k = ["product_id", "location_id", "lot_id", "package_id", "owner_id"].map((f) => idOf(q[f])).join(":");
      const m = merged.get(k);
      if (m) {
        m.quantity = round((m.quantity || 0) + (q.quantity || 0));
        m.inventory_quantity_set = m.inventory_quantity_set || q.inventory_quantity_set;
      } else merged.set(k, { ...q });
    }
    const quants = [...merged.values()].filter((q) => Math.abs(q.quantity || 0) > EPS || q.inventory_quantity_set);
    const productIds = uniq(quants.map((q) => idOf(q.product_id)));
    const codes = new Map();
    for (let i = 0; i < productIds.length; i += 1000) {
      for (const p of await client.call("product.product", "read", [productIds.slice(i, i + 1000), ["default_code", "display_name"]], {}, { active_test: false })) {
        codes.set(p.id, p.default_code || p.display_name);
      }
    }
    const withPackage = quants.some((q) => q.package_id);
    const withOwner = quants.some((q) => q.owner_id);
    quants.sort((a, b) => nameOf(a.location_id).localeCompare(nameOf(b.location_id)) || String(codes.get(idOf(a.product_id))).localeCompare(String(codes.get(idOf(b.product_id)))) || nameOf(a.lot_id).localeCompare(nameOf(b.lot_id)));
    const headers = ["Product", "Lot/Serial Number", "Location", ...(withPackage ? ["Package"] : []), ...(withOwner ? ["Owner"] : []), "On Hand (not imported)", "Counted Quantity"];
    const rows = quants.map((q) => [
      codes.get(idOf(q.product_id)) || nameOf(q.product_id), nameOf(q.lot_id), nameOf(q.location_id),
      ...(withPackage ? [nameOf(q.package_id)] : []), ...(withOwner ? [nameOf(q.owner_id)] : []), q.quantity, null,
    ]);
    const types = headers.map((h) => (h.startsWith("On Hand") || h === "Counted Quantity" ? "number" : "text"));
    const safe = (label || "stock").replace(/[\\/:*?"<>|]+/g, " ").trim();
    return {
      fileName: `Count sheet ${safe} ${new Date().toISOString().slice(0, 10)}.xlsx`,
      rows: rows.length,
      sheets: [{ name: "Count", headers, rows, types }],
    };
  }

  NS.inventory = { MODEL, MODES, TESTED, tested, active, ensure, setMode, columns, ownCols, problems, readRows, compute, prepare, soleLocation, run, undo, apply, countSheet, soleDefault };
})();
