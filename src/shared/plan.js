/* Odoo Import Export: from a mapped table to conflicts and, once they are settled, to the
 * exact matrix sent to Odoo.
 *
 * A job is a plain object the UI owns:
 *   model, table {headers, rows, lines}, profiles[], mapping[] (see columns.automap, plus
 *   `fields`: the resolved field objects of each path and `confirmed`), and the state
 *   filled in below: rel, resolutions, links, key, existing, decisions, defaults,
 *   requiredMissing.
 *
 * analyze(job) is synchronous and cheap (it works on distinct values), so the UI calls it
 * after every decision. Decisions are keyed by conflict, so they survive re-analysis.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const { convert, REASONS } = NS.values;
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  const REL_TYPES = new Set(["many2one", "many2many"]);

  function newJob(model, table) {
    return {
      model,
      table,
      profiles: [],
      mapping: [],
      rel: new Map(), // col -> {field, mode, sep}: the relational field a column resolves
      resolutions: new Map(), // col -> Map raw value -> m2o result
      links: new Map(), // col -> [{field, col}] narrowing links to other columns
      key: null, // {col, field, mode: "update" | "skip" | "create"}
      existing: new Map(), // lower(key value) -> [{id, label}]
      decisions: new Map(), // conflict key -> {action, id?, value?, label?}
      defaults: new Map(), // field name -> {out, label}: constant for every record
      requiredMissing: [], // required fields without column nor Odoo default
    };
  }

  // Active mappings: a path, resolved fields, and not ignored.
  function active(job) {
    return job.mapping.filter((m) => m.path && m.fields && m.status !== "ignored");
  }

  const isSub = (m) => m.fields.length >= 2 && m.fields[0].type === "one2many";

  // The relational field a mapping resolves values for, if any.
  function relationOf(m) {
    const f = m.fields;
    const last = f[f.length - 1];
    if (REL_TYPES.has(last.type)) return { field: last, mode: "name" };
    if ((last.type === "id" || last.type === "dbid") && f.length >= 2 && REL_TYPES.has(f[f.length - 2].type)) {
      return { field: f[f.length - 2], mode: last.type === "id" ? "xmlid" : "dbid" };
    }
    return null;
  }

  // Values of a cell for a relational column: many2many cells hold lists.
  function pieces(job, col, raw) {
    const s = String(raw ?? "").trim();
    if (!s) return [];
    const rel = job.rel.get(col);
    if (rel && rel.field.type === "many2many") return s.split(rel.sep).map((x) => x.trim()).filter(Boolean);
    return [s];
  }

  /* Resolve every relational column against Odoo, and look up existing records for the key.
   * deps: {schemas, resolver, valueMemory(relation) -> Map, onProgress(text)} */
  async function resolveAll(job, deps) {
    const maps = active(job);
    job.rel = new Map();
    for (const m of maps) {
      const r = relationOf(m);
      if (r) job.rel.set(m.col, { ...r, sep: (job.profiles[m.col] && job.profiles[m.col].list) || "," });
    }
    // Narrowing links: a comodel many2one pointing to the comodel of another mapped column
    // (state -> country, contact -> parent company, anything -> company).
    job.links = new Map();
    for (const [col, r] of job.rel) {
      if (r.field.type !== "many2one") continue;
      const schema = await deps.schemas.load(r.field.relation);
      const links = [];
      for (const [other, ro] of job.rel) {
        if (other === col || ro.field.type !== "many2one") continue;
        for (const f of schema.fields.values()) {
          if (f.type === "many2one" && f.relation === ro.field.relation && f.store) links.push({ field: f.name, col: other });
        }
      }
      job.links.set(col, links);
    }
    job.resolutions = new Map();
    let n = 0;
    for (const [col, r] of job.rel) {
      n++;
      NS.rpc.throwIfAborted(deps.signal);
      if (deps.onProgress) deps.onProgress(`Matching ${job.table.headers[col]} (${n}/${job.rel.size})…`);
      const values = [...new Set(job.table.rows.flatMap((row) => pieces(job, col, row[col])))];
      const res = await deps.resolver.resolve({
        relation: r.field.relation,
        values,
        mode: r.mode,
        linkFields: (job.links.get(col) || []).map((l) => l.field),
        memory: deps.valueMemory ? await deps.valueMemory(r.field.relation) : new Map(),
        signal: deps.signal,
      });
      job.resolutions.set(col, res);
    }
    await lookupExisting(job, deps);
  }

  async function lookupExisting(job, deps) {
    job.existing = new Map();
    if (!job.key || job.key.mode === "create") return;
    if (deps.onProgress) deps.onProgress("Looking for existing records…");
    const values = recordRows(job).map((i) => job.table.rows[i][job.key.col]);
    job.existing = await NS.records.findExisting(deps.client, job.model, job.key.field, values);
  }

  // Indices of rows that start a record. With one2many sub-columns, a row whose parent
  // columns are all empty continues the record above (Odoo's export layout).
  function recordRows(job) {
    const maps = active(job);
    const parents = maps.filter((m) => !isSub(m)).map((m) => m.col);
    const rows = job.table.rows;
    if (!maps.some(isSub) || !parents.length) return rows.map((_, i) => i);
    const out = [];
    rows.forEach((r, i) => {
      if (i === 0 || parents.some((c) => String(r[c] ?? "").trim())) out.push(i);
    });
    return out;
  }

  function groups(job) {
    const starts = recordRows(job);
    return starts.map((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : job.table.rows.length;
      return Array.from({ length: end - s }, (_, j) => s + j);
    });
  }

  // ---------------------------------------------------------------------------
  // analysis
  function fieldLabel(m) {
    return m.fields.map((f) => f.string).join(" / ");
  }

  /* Returns {conflicts, warnings, cell(col,row) -> {out}|null, rowId, skipRows, stats}.
   * Conflicts block the import until decided; warnings don't. */
  function analyze(job) {
    const conflicts = [];
    const warnings = [];
    const maps = active(job);
    const rows = job.table.rows;
    const decided = (key) => job.decisions.get(key);
    const conv = new Map(); // col -> Map raw -> result
    const rowId = new Map(); // `${col}:${row}` -> id from row-context narrowing
    const byKey = new Map();

    const push = (list, c) => {
      if (byKey.has(c.key)) {
        byKey.get(c.key).rows.push(...c.rows);
        return;
      }
      byKey.set(c.key, c);
      list.push(c);
    };

    // 1. mappings that are only suggestions
    for (const m of job.mapping) {
      if (m.status === "suggest" && !m.confirmed) {
        conflicts.push({
          key: `column:${m.col}`, kind: "column", col: m.col, value: job.table.headers[m.col], rows: [],
          title: `Column “${job.table.headers[m.col]}” → ${m.fields ? fieldLabel(m) : m.path.join("/")}?`,
          message: `Matched by ${m.source === "fuzzy" ? "a similar name" : m.source} (${Math.round(m.score * 100)}%).`,
          candidates: m.candidates,
        });
      }
    }

    // 2. dates whose day/month order can't be told from the values
    for (const m of maps) {
      const last = m.fields[m.fields.length - 1];
      const p = job.profiles[m.col];
      if ((last.type === "date" || last.type === "datetime") && p.dateAmbiguous && !p.dateOrderConfirmed) {
        conflicts.push({
          key: `dateorder:${m.col}`, kind: "dateorder", col: m.col, value: p.samples[0], rows: [],
          title: `Dates in “${job.table.headers[m.col]}”: day/month or month/day?`,
          message: `Values like ${p.samples.slice(0, 3).join(", ")} read either way.`,
          candidates: [{ id: "DMY", label: "Day/Month/Year" }, { id: "MDY", label: "Month/Day/Year" }],
        });
      }
    }

    // 3. required fields without a column nor default. Odoo may still compute them (a sale
    // order's invoice address comes from the customer), so this only warns: the dry run decides.
    const mappedTop = new Set(maps.filter((m) => !isSub(m)).map((m) => m.path[0]));
    for (const f of job.requiredMissing) {
      if (mappedTop.has(f.name) || job.defaults.has(f.name)) continue;
      warnings.push({
        key: `requiredcol:${f.name}`, kind: "requiredcol", field: f, rows: [],
        title: `Required field “${f.string}” has no column`,
        message: "Odoo may fill it in (computed from other fields); otherwise set one value for every record. The check will tell.",
        candidates: [],
      });
    }

    const starts = new Set(recordRows(job));

    // 4. cell values
    for (const m of maps) {
      const col = m.col;
      const last = m.fields[m.fields.length - 1];
      const rel = job.rel.get(col);
      const cache = new Map();
      conv.set(col, cache);
      const res = job.resolutions.get(col) || new Map();
      const links = job.links.get(col) || [];
      const header = job.table.headers[col];

      for (let i = 0; i < rows.length; i++) {
        const raw = String(rows[i][col] ?? "").trim();
        if (!raw) continue;
        if (!rel) {
          if (!cache.has(raw)) cache.set(raw, convert(last, raw, job.profiles[col]));
          const r = cache.get(raw);
          if (r.ok) continue;
          const key = `value:${col}:${lower(raw)}`;
          if (decided(key)) continue;
          push(conflicts, {
            key, kind: "value", col, value: raw, rows: [i], field: last,
            title: `“${raw}” ${REASONS[r.reason] || "can't be imported"}`,
            message: `Column “${header}” → ${fieldLabel(m)}`,
            candidates: (r.candidates || []).slice(0, 6),
          });
          continue;
        }
        for (const piece of pieces(job, col, raw)) {
          const r = res.get(piece);
          if (!r) continue;
          const key = `m2o:${col}:${lower(piece)}`;
          if (r.status === "ok") continue;
          if (r.status === "ambiguous" && links.length) {
            // Narrow with the other columns of the same row (country of a state, company...).
            let cands = r.candidates;
            for (const l of links) {
              const other = linkedId(job, l.col, i);
              if (other) {
                const narrowed = cands.filter((c) => c.links[l.field] === other);
                if (narrowed.length) cands = narrowed;
              }
            }
            if (cands.length === 1) {
              rowId.set(`${col}:${i}:${lower(piece)}`, cands[0].id);
              continue;
            }
          }
          if (decided(key)) continue;
          const rel2 = rel.field.relation;
          const base = { key, kind: "m2o", status: r.status, col, value: piece, rows: [i], relation: rel2, field: rel.field, candidates: r.candidates };
          if (r.status === "archived") {
            push(warnings, { ...base, title: `“${piece}” is archived`, message: `${header}: the only match is an archived ${rel.field.string} record; it will be used.` });
          } else if (r.status === "probable") {
            push(conflicts, { ...base, title: `“${piece}” → ${r.candidates[0].label}?`, message: `${header}: no exact match in ${rel.field.string}; this one is close.` });
          } else if (r.status === "ambiguous") {
            push(conflicts, { ...base, title: `“${piece}” matches ${r.candidates.length} records`, message: `${header}: pick the right ${rel.field.string}.` });
          } else {
            push(conflicts, { ...base, title: `“${piece}” not found`, message: `${header}: no ${rel.field.string} with this name${r.candidates.length ? "; similar ones below" : ""}.` });
          }
        }
      }
    }

    // 5. required fields mapped but empty on some records
    const skipRows = new Set();
    for (const [key, d] of job.decisions) {
      if (d.action !== "skip") continue;
      const c = byKey.get(key) || null;
      if (c) for (const r of c.rows) skipRows.add(r);
      else if (d.rows) for (const r of d.rows) skipRows.add(r);
    }
    for (const m of maps) {
      if (isSub(m)) continue;
      const f = m.fields[0];
      if (!f.required || (job.fieldDefaults && f.name in job.fieldDefaults)) continue; // Odoo fills it
      const empty = [...starts].filter((i) => !skipRows.has(i) && cellEmpty(job, m, i));
      const key = `requiredempty:${m.col}`;
      const d = decided(key);
      if (!empty.length || (d && (d.action === "default" || d.action === "skip"))) {
        if (d && d.action === "skip") for (const i of empty) skipRows.add(i);
        continue;
      }
      conflicts.push({
        key, kind: "requiredempty", col: m.col, rows: empty, field: f,
        title: `${empty.length} record${empty.length > 1 ? "s have" : " has"} no ${f.string}`,
        message: `“${f.string}” is required. Set one value for these rows or skip them.`,
        candidates: [],
      });
    }

    // 6. record matching: duplicates in the file, several existing matches
    const stats = { records: starts.size, create: 0, update: 0, skip: 0, rows: rows.length };
    if (job.key) {
      const seen = new Map();
      for (const i of starts) {
        const v = lower(rows[i][job.key.col]);
        if (!v) continue;
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v).push(i);
      }
      for (const [v, list] of seen) {
        if (list.length < 2) continue;
        const key = `duplicate:${v}`;
        const d = decided(key);
        if (d && d.action === "first") list.slice(1).forEach((i) => skipRows.add(i));
        else if (d && d.action === "last") list.slice(0, -1).forEach((i) => skipRows.add(i));
        if (!d) {
          push(warnings, {
            key, kind: "duplicate", col: job.key.col, value: rows[list[0]][job.key.col], rows: list,
            title: `${list.length} rows share ${job.key.label || job.key.field} “${rows[list[0]][job.key.col]}”`,
            message: "All of them are imported unless you keep only one.",
            candidates: [],
          });
        }
      }
      if (job.key.mode !== "create" && job.key.field !== "id" && job.key.field !== ".id") {
        for (const i of starts) {
          const found = job.existing.get(lower(rows[i][job.key.col])) || [];
          if (found.length < 2) continue;
          const key = `existing:${lower(rows[i][job.key.col])}`;
          if (decided(key)) continue;
          push(conflicts, {
            key, kind: "existing", col: job.key.col, value: rows[i][job.key.col], rows: [i],
            title: `“${rows[i][job.key.col]}” matches ${found.length} existing records`,
            message: "Pick the record to update, create a new one, or skip.",
            candidates: found.map((r) => ({ id: r.id, label: r.label, score: 1 })),
          });
        }
      }
    }

    for (const i of starts) {
      if (skipRows.has(i)) {
        stats.skip++;
        continue;
      }
      const target = existingTarget(job, i);
      if (target === "skip") stats.skip++;
      else if (target) stats.update++;
      else stats.create++;
    }

    return { conflicts, warnings, conv, rowId, skipRows, stats, starts };
  }

  // The id a relational column resolves to on a given row (for narrowing), if settled.
  function linkedId(job, col, row) {
    const raw = String(job.table.rows[row][col] ?? "").trim();
    if (!raw) return null;
    const r = (job.resolutions.get(col) || new Map()).get(raw);
    const d = job.decisions.get(`m2o:${col}:${lower(raw)}`);
    if (d && d.action === "pick") return d.id;
    return r && (r.status === "ok" || r.status === "archived") ? r.id : null;
  }

  function cellEmpty(job, m, i) {
    const raw = String(job.table.rows[i][m.col] ?? "").trim();
    if (!raw) return true;
    const d = job.decisions.get(job.rel.has(m.col) ? `m2o:${m.col}:${lower(raw)}` : `value:${m.col}:${lower(raw)}`);
    return !!(d && d.action === "empty");
  }

  // Existing record a record row updates: an id, "skip", or null (create).
  function existingTarget(job, i) {
    if (!job.key || job.key.mode === "create") return null;
    const v = lower(job.table.rows[i][job.key.col]);
    if (!v) return null;
    if (job.key.field === "id" || job.key.field === ".id") {
      const found = job.existing.get(v) || [];
      return found.length ? (job.key.mode === "skip" ? "skip" : found[0].id) : null;
    }
    const d = job.decisions.get(`existing:${v}`);
    if (d) return d.action === "pick" ? d.id : d.action === "skip" ? "skip" : null;
    const found = job.existing.get(v) || [];
    if (found.length !== 1) return null;
    return job.key.mode === "skip" ? "skip" : found[0].id;
  }

  // ---------------------------------------------------------------------------
  // records to create before the import (many2one values the user chose to create)
  function toCreate(job) {
    const out = new Map(); // `${relation}\u0000${name}` -> {relation, name}
    for (const [key, d] of job.decisions) {
      if (d.action !== "create" || !key.startsWith("m2o:")) continue;
      const col = Number(key.split(":")[1]);
      const rel = job.rel.get(col);
      if (!rel) continue;
      const name = d.value;
      out.set(`${rel.field.relation}\u0000${lower(name)}`, { relation: rel.field.relation, name });
    }
    return [...out.values()];
  }

  /* Build the matrix for Odoo.
   * created: Map `${relation}\u0000${lower(name)}` -> id (records created for this import)
   * placeholder: Map relation -> id, used for still-to-create values during a dry run.
   * part: with record matching by a key, "update" (records found, with their ".id") or
   * "create" (the others, without the column: Odoo 16 refuses an empty ".id").
   * Returns {fields, columns, rows, groups: [{src: [rowIdx], out: [start, end]}]}. */
  function build(job, analysis, { created = new Map(), placeholder = new Map(), part = null } = {}) {
    const maps = active(job);
    const rows = job.table.rows;
    const fields = [];
    const columns = [];
    const writers = []; // (rowIndex, isStart) -> string

    for (const m of maps) {
      const col = m.col;
      const rel = job.rel.get(col);
      const last = m.fields[m.fields.length - 1];
      // A column empty on every row carries nothing; sending it would wipe Odoo's defaults.
      const reqDecision = job.decisions.get(`requiredempty:${col}`);
      if (!rows.some((r) => String(r[col] ?? "").trim()) && !(reqDecision && reqDecision.action === "default")) continue;
      const fieldDefault = !isSub(m) && job.fieldDefaults ? job.fieldDefaults[m.fields[0].name] : undefined;
      let path;
      if (rel) {
        const names = m.fields.map((f) => f.name);
        const relIdx = m.fields.indexOf(rel.field);
        path = `${names.slice(0, relIdx + 1).join("/")}/.id`;
      } else {
        path = m.fields.map((f) => f.name).join("/");
      }
      fields.push(path);
      columns.push(job.table.headers[col]);
      const cache = analysis.conv.get(col);
      const res = job.resolutions.get(col) || new Map();
      const reqKey = `requiredempty:${col}`;
      writers.push((i, isStart) => {
        const raw = String(rows[i][col] ?? "").trim();
        if (!raw) {
          const d = job.decisions.get(reqKey);
          if (isStart && d && d.action === "default") return d.out;
          // A new record with an empty required cell gets Odoo's default (not on updates).
          return isStart && fieldDefault !== undefined && !existingTarget(job, i) ? fieldDefault : "";
        }
        if (!rel) {
          const d = job.decisions.get(`value:${col}:${lower(raw)}`);
          if (d) {
            if (d.action === "empty") return "";
            if (d.action === "pick") return String(d.id);
            if (d.action === "value") {
              const r = convert(last, d.value, job.profiles[col]);
              return r.ok ? r.out : "";
            }
          }
          const r = cache.get(raw) || convert(last, raw, job.profiles[col]);
          return r.ok ? r.out : "";
        }
        const ids = [];
        for (const piece of pieces(job, col, raw)) {
          const k = lower(piece);
          const d = job.decisions.get(`m2o:${col}:${k}`);
          // A row narrowed by its other columns wins over the decision taken for the value.
          let id = analysis.rowId.get(`${col}:${i}:${k}`) || null;
          if (id) {
            // settled by the row context
          } else if (d) {
            if (d.action === "pick") id = d.id;
            else if (d.action === "create") {
              const ck = `${rel.field.relation}\u0000${lower(d.value)}`;
              id = created.get(ck) || placeholder.get(rel.field.relation) || null;
            }
          } else {
            const r = res.get(piece);
            if (r && (r.status === "ok" || r.status === "archived")) id = r.id;
          }
          if (id) ids.push(id);
        }
        if (!ids.length) {
          const d = job.decisions.get(reqKey);
          return isStart && d && d.action === "default" ? d.out : "";
        }
        return rel.field.type === "many2many" ? ids.join(",") : String(ids[0]);
      });
    }

    for (const [name, d] of job.defaults) {
      fields.push(d.path || name);
      columns.push(false);
      writers.push((i, isStart) => (isStart ? d.out : ""));
    }

    if (needsDbId(job) && part !== "create") {
      fields.push(".id");
      columns.push(false);
      writers.push((i, isStart) => {
        if (!isStart) return "";
        const t = existingTarget(job, i);
        return t && t !== "skip" ? String(t) : "";
      });
    }

    const out = [];
    const outGroups = [];
    for (const g of groups(job)) {
      const start = g[0];
      const target = existingTarget(job, start);
      if (analysis.skipRows.has(start) || target === "skip") continue;
      if ((part === "update" && !target) || (part === "create" && target)) continue;
      const begin = out.length;
      for (const i of g) if (i === start || !analysis.skipRows.has(i)) out.push(writers.map((w) => w(i, i === start)));
      outGroups.push({ src: g, out: [begin, out.length] });
    }
    return { fields, columns, rows: out, groups: outGroups };
  }

  // Rows are matched to existing records by a key other than the External / Database ID.
  function needsDbId(job) {
    return !!(job.key && job.key.mode === "update" && job.key.field !== "id" && job.key.field !== ".id");
  }

  NS.plan = { needsDbId, newJob, active, relationOf, pieces, resolveAll, lookupExisting, recordRows, groups, analyze, build, toCreate, existingTarget, isSub };
})();
