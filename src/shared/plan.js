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
      inFile: new Map(), // col -> Map ref -> [rows]: rows of the file a self-referencing value can name
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
    job.inFile = [...job.rel.values()].some((r) => r.field.relation === job.model)
      ? fileIndex(job, ["name", "complete_name", ...(await deps.schemas.keyFields(job.model))])
      : new Map();
    await lookupExisting(job, deps);
  }

  // How a self-referencing value names a row: "__import__.x" and "x" are the same external id.
  const refKey = (v, mode) => (mode === "xmlid" ? lower(v).replace(/^__import__\./, "") : lower(v));

  /* Self-references: a relational column pointing at the imported model itself (a contact's
   * parent company, a category's parent) may name a record that is a row of this same file.
   * Indexes the record rows by the columns such a value can name them by: the External ID for
   * external-id columns, else the name and the model's alternate keys (keyNames).
   * Returns col -> Map refKey -> [record rows]. */
  function fileIndex(job, keyNames) {
    const out = new Map();
    const top = active(job).filter((m) => !isSub(m));
    const starts = recordRows(job);
    for (const [col, r] of job.rel) {
      if (r.field.relation !== job.model || r.mode === "dbid" || !top.some((m) => m.col === col)) continue;
      const sources = top
        .filter((m) => m.path.length === 1 && (r.mode === "xmlid" ? m.path[0] === "id" : keyNames.includes(m.path[0])))
        .map((m) => m.col);
      const index = new Map();
      for (const i of starts) {
        for (const c of sources) {
          const k = refKey(job.table.rows[i][c], r.mode);
          if (!k) continue;
          if (!index.has(k)) index.set(k, []);
          if (!index.get(k).includes(i)) index.get(k).push(i);
        }
      }
      if (index.size) out.set(col, index);
    }
    return out;
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

  /* Returns {conflicts, warnings, conv, rowId, inFile, levels, skipRows, stats, starts}.
   * Conflicts block the import until decided; warnings don't.
   * inFile: `${col}:${row}:${lower(value)}` -> the row whose new record the value links to;
   * levels: row -> import round (a record linking to a new record of the file goes after it). */
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

    // A relational value that isn't a plain match: narrowed by the row, or a conflict.
    const m2oIssue = (col, i, piece) => {
      const rel = job.rel.get(col);
      const r = (job.resolutions.get(col) || new Map()).get(piece);
      const links = job.links.get(col) || [];
      const header = job.table.headers[col];
      const key = `m2o:${col}:${lower(piece)}`;
      if (r.status === "ok") return;
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
          return;
        }
      }
      if (decided(key)) return;
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
    };
    // Values naming another row of the file, settled once the skipped rows are known (7.).
    const pending = [];
    // Columns a stock count resolves itself (lot names, per product): no conflicts for them.
    const own = NS.inventory ? NS.inventory.ownCols(job) : new Set();

    // 4. cell values
    for (const m of maps) {
      const col = m.col;
      const last = m.fields[m.fields.length - 1];
      const rel = job.rel.get(col);
      const cache = new Map();
      conv.set(col, cache);
      const res = job.resolutions.get(col) || new Map();
      const index = job.inFile && job.inFile.get(col);
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
        if (own.has(col)) continue;
        for (const piece of pieces(job, col, raw)) {
          const r = res.get(piece);
          if (!r) continue;
          // A record of this file (not the row itself), unless the value was decided otherwise.
          const targets = index ? (index.get(refKey(piece, rel.mode)) || []).filter((t) => t !== i) : [];
          if (targets.length && !decided(`m2o:${col}:${lower(piece)}`)) {
            pending.push({ col, i, piece, r, targets, header });
            continue;
          }
          m2oIssue(col, i, piece);
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

    // 7. values naming a row of this file: that row's record, existing or about to be created.
    // New ones are linked in rounds: a record goes after the records of the file it links to.
    const inFile = new Map();
    const edges = new Map(); // row -> [{t, k, col, piece}]
    for (const p of pending) {
      const k = `${p.col}:${p.i}:${lower(p.piece)}`;
      const cycleKey = `cycle:${p.col}:${p.i}`;
      if (skipRows.has(p.i)) continue;
      if (decided(cycleKey)) {
        rowId.set(k, null); // left empty (a skipped row is in skipRows)
        continue;
      }
      const live = p.targets.filter((t) => existingId(job, t) || (!skipRows.has(t) && existingTarget(job, t) !== "skip"));
      if (!live.length) {
        m2oIssue(p.col, p.i, p.piece); // its row isn't imported: look it up in Odoo as usual
        continue;
      }
      const t = live[0];
      const id = existingId(job, t);
      const field = job.rel.get(p.col).field;
      if (id) rowId.set(k, id);
      else {
        inFile.set(k, t);
        if (!edges.has(p.i)) edges.set(p.i, []);
        edges.get(p.i).push({ t, k, col: p.col, piece: p.piece, header: p.header, field });
      }
      if (live.length > 1) {
        push(warnings, {
          key: `infile:${p.col}:${lower(p.piece)}`, kind: "infile", col: p.col, value: p.piece, rows: [p.i], candidates: [],
          title: `“${p.piece}” is the name of ${live.length} rows of this file`,
          message: `${p.header}: linked to the first one (row ${job.table.lines[t]}).`,
        });
      } else if (!id && p.r.status === "ok") {
        push(warnings, {
          key: `infile:${p.col}:${lower(p.piece)}`, kind: "infile", col: p.col, value: p.piece, rows: [p.i], candidates: [],
          title: `“${p.piece}” is also an existing ${field.string}`,
          message: `${p.header}: linked to the record created from row ${job.table.lines[t]}, not to the existing one.`,
        });
      }
    }
    // Rounds by depth, walked without recursion (a long chain of rows must not overflow the stack).
    // A link closing a circle can't be set: it becomes a conflict for its row.
    const levels = new Map();
    const state = new Map(); // row -> 1 on the current path, 2 done
    for (const root of edges.keys()) {
      if (state.has(root)) continue;
      const stack = [[root, 0]];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const out = edges.get(top[0]) || [];
        if (top[1] < out.length) {
          const e = out[top[1]++];
          const s = state.get(e.t);
          if (s === 1) {
            inFile.delete(e.k);
            e.cycle = true;
            const path = stack.slice(stack.findIndex((x) => x[0] === e.t)).map((x) => job.table.lines[x[0]]);
            const line = job.table.lines[top[0]];
            push(conflicts, {
              key: `cycle:${e.col}:${top[0]}`, kind: "cycle", col: e.col, value: e.piece, rows: [top[0]], field: e.field, candidates: [],
              title: `Row ${line}: “${e.piece}” leads back to this row`,
              message: `${e.header}: rows ${[line, ...path].join(" → ")} point to each other in a circle. Leave this link empty or skip the row.`,
            });
          } else if (!s) {
            state.set(e.t, 1);
            stack.push([e.t, 0]);
          }
          continue;
        }
        stack.pop();
        state.set(top[0], 2);
        let level = 0;
        for (const e of out) if (!e.cycle) level = Math.max(level, (levels.get(e.t) || 0) + 1);
        if (level) levels.set(top[0], level);
      }
    }
    stats.inFile = inFile.size;

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

    return { conflicts, warnings, conv, rowId, inFile, levels, skipRows, stats, starts };
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
    const d = job.key.field === "id" || job.key.field === ".id" ? null : job.decisions.get(`existing:${v}`);
    if (d) return d.action === "pick" ? d.id : d.action === "skip" ? "skip" : null;
    const id = existingId(job, i);
    return id && job.key.mode === "skip" ? "skip" : id;
  }

  // The existing record a record row stands for, updated or not (null: the row creates one).
  function existingId(job, i) {
    if (!job.key || job.key.mode === "create") return null;
    const v = lower(job.table.rows[i][job.key.col]);
    if (!v) return null;
    const found = job.existing.get(v) || [];
    if (job.key.field === "id" || job.key.field === ".id") return found.length ? found[0].id : null;
    const d = job.decisions.get(`existing:${v}`);
    if (d) return d.action === "pick" ? d.id : null;
    return found.length === 1 ? found[0].id : null;
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
   * level: only the records of this round (analysis.levels); null for all.
   * rowIds: Map row -> id of the records of earlier rounds, for links to rows of the file (left
   * empty until known: a dry run rolls every round back).
   * linked: with xmlids, false for the records without links to rows of the file, true for the
   * others, sorted so that a record comes after the records it links to.
   * xmlids: Map row -> external id (see xmlids()): the rows other rows link to get it in the
   * "id" column, and the links are sent as external ids, which Odoo resolves as it imports.
   * Returns {fields, columns, rows, groups: [{src: [rowIdx], out: [start, end]}], mixed}; mixed:
   * a link column of the linked records also names existing records (by database id), which
   * can't go with external ids in one column. */
  function build(job, analysis, { created = new Map(), placeholder = new Map(), part = null, level = null, rowIds = new Map(), linked = null, xmlids = null } = {}) {
    const maps = active(job);
    const rows = job.table.rows;
    const fields = [];
    const columns = [];
    const writers = []; // (rowIndex, isStart) -> string
    const inFile = analysis.inFile || new Map();
    const linkedRows = new Set([...inFile.keys()].map((k) => Number(k.split(":")[1])));
    const xmlCols = linked && xmlids ? new Set([...inFile.keys()].map((k) => Number(k.split(":")[0]))) : new Set();
    const withXmlid = !!(xmlids && part !== "update");
    let mixed = false;

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
        path = `${names.slice(0, relIdx + 1).join("/")}/${xmlCols.has(col) ? "id" : ".id"}`;
      } else {
        path = m.fields.map((f) => f.name).join("/");
      }
      fields.push(path);
      columns.push(job.table.headers[col]);
      const cache = analysis.conv.get(col);
      const res = job.resolutions.get(col) || new Map();
      const reqKey = `requiredempty:${col}`;
      const ownXmlid = withXmlid && !isSub(m) && m.path.length === 1 && m.path[0] === "id";
      writers.push((i, isStart) => {
        const raw = String(rows[i][col] ?? "").trim();
        if (!raw && ownXmlid && isStart && xmlids.has(i)) return xmlids.get(i);
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
          const at = `${col}:${i}:${k}`;
          // A record of this file, or a row narrowed by its other columns, wins over the
          // decision taken for the value.
          let id = null;
          if (xmlCols.has(col) && inFile.has(at)) id = xmlids.get(inFile.get(at)) || null;
          else if (inFile.has(at)) id = rowIds.get(inFile.get(at)) || null;
          else if (analysis.rowId.has(at)) id = analysis.rowId.get(at);
          else if (d) {
            if (d.action === "pick") id = d.id;
            else if (d.action === "create") {
              const ck = `${rel.field.relation}\u0000${lower(d.value)}`;
              id = created.get(ck) || placeholder.get(rel.field.relation) || null;
            }
          } else {
            const r = res.get(piece);
            if (r && (r.status === "ok" || r.status === "archived")) id = r.id;
          }
          if (id && xmlCols.has(col) && !inFile.has(at)) mixed = true;
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

    // The external ids of the rows linked to, unless a mapped External ID column carries them.
    const idColumn = withXmlid && !fields.includes("id");
    if (idColumn) {
      fields.push("id");
      columns.push(false);
      writers.push((i, isStart) => (isStart && xmlids.has(i) ? xmlids.get(i) : ""));
    }

    let list = groups(job);
    if (linked !== null) list = list.filter((g) => linkedRows.has(g[0]) === linked);
    if (linked) list.sort((a, b) => ((analysis.levels && analysis.levels.get(a[0])) || 0) - ((analysis.levels && analysis.levels.get(b[0])) || 0));
    const out = [];
    const outGroups = [];
    for (const g of list) {
      const start = g[0];
      const target = existingTarget(job, start);
      if (analysis.skipRows.has(start) || target === "skip") continue;
      if ((part === "update" && !target) || (part === "create" && target)) continue;
      if (level !== null && ((analysis.levels && analysis.levels.get(start)) || 0) !== level) continue;
      const begin = out.length;
      for (const i of g) if (i === start || !analysis.skipRows.has(i)) out.push(writers.map((w) => w(i, i === start)));
      outGroups.push({ src: g, out: [begin, out.length] });
    }
    // An "id" column nobody needs here: left out (an update must not get one).
    if (idColumn && !out.some((r) => r[fields.length - 1])) {
      fields.pop();
      columns.pop();
      for (const r of out) r.pop();
    }
    return { fields, columns, rows: out, groups: outGroups, mixed };
  }

  /* External ids for the rows other rows of the file link to, for a batch-wise import: the
   * row's own External ID when it has one, else one made of stamp (unique per import) and the
   * row's line. Odoo resolves a link to a record of an earlier row of the same batch too. */
  function xmlids(job, analysis, stamp) {
    const idCol = active(job).find((m) => !isSub(m) && m.path.length === 1 && m.path[0] === "id");
    const out = new Map();
    for (const t of new Set((analysis.inFile || new Map()).values())) {
      const own = idCol ? String(job.table.rows[t][idCol.col] ?? "").trim() : "";
      out.set(t, own ? (own.includes(".") ? own : `__import__.${own}`) : `__import__.oi_${stamp}_${job.table.lines[t]}`);
    }
    return out;
  }

  // Rows are matched to existing records by a key other than the External / Database ID.
  function needsDbId(job) {
    return !!(job.key && job.key.mode === "update" && job.key.field !== "id" && job.key.field !== ".id");
  }

  NS.plan = { needsDbId, newJob, active, relationOf, pieces, resolveAll, fileIndex, lookupExisting, recordRows, groups, analyze, build, xmlids, toCreate, existingTarget, existingId, isSub };
})();
