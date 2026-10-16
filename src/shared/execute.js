/* Odoo Import Export: run the import through Odoo's own engine.
 *
 * The planned matrix is written as a normalized CSV and sent, batch by batch, to
 * base_import.import.execute_import: the same code path as Odoo's import screen, with
 * its validations, onchange-free load() and per-row messages. A dry run executes
 * everything and rolls it back. Without base_import, model.load() is used directly
 * (no dry run possible then).
 *
 * Records the user chose to create (missing many2one values) are created first with
 * name_create; during a dry run an existing record stands in for them.
 *
 * Records linking to other new records of the same file (a contact and its parent company)
 * are imported after the records they link to, the links sent as external ids: Odoo resolves
 * them as it imports, in the same batch or an earlier one. When a link column also names
 * existing records, they are imported in rounds instead, each round with the ids of the last.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // Split record groups into batches of at most `size` rows (a record is never split).
  function batches(groups, size) {
    const out = [];
    let cur = [];
    let rows = 0;
    for (const g of groups) {
      const n = g.out[1] - g.out[0];
      if (cur.length && rows + n > size) {
        out.push(cur);
        cur = [];
        rows = 0;
      }
      cur.push(g);
      rows += n;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function createExecutor(client) {
    let hasBaseImport = null;
    let rawFile = false;

    // Is base_import installed, and how does it want the file? Up to Odoo 19.0 the field holds
    // the raw content ("raw binary (not base64)", as its help says); later versions take base64.
    async function baseImportAvailable() {
      if (hasBaseImport === null) {
        try {
          const f = await client.call("base_import.import", "fields_get", [["res_model", "file"]], { attributes: ["type", "help"] });
          hasBaseImport = true;
          rawFile = /not base64/i.test((f.file && f.file.help) || "");
        } catch {
          hasBaseImport = false;
        }
      }
      return hasBaseImport;
    }

    async function runBatch(model, matrix, rows, dryrun, context) {
      const options = {
        has_headers: true,
        quoting: '"',
        separator: ",",
        encoding: "utf-8",
        ...NS.values.CSV_OPTIONS,
        fallback_values: {},
        name_create_enabled_fields: {},
        import_set_empty_fields: [],
        import_skip_records: [],
      };
      if (await baseImportAvailable()) {
        const csv = NS.csv.serialize([matrix.fields, ...rows]);
        // The import wizard is a temporary record: creating it again after a dropped connection is harmless.
        const wizardValues = [{ res_model: model, file: rawFile ? csv : base64(csv), file_name: "odoo-import.csv", file_type: "text/csv" }];
        let res;
        try {
          res = await client.call("base_import.import", "create", wizardValues);
        } catch (e) {
          if (e.title !== "Network error") throw e;
          await new Promise((r) => setTimeout(r, 800));
          res = await client.call("base_import.import", "create", wizardValues);
        }
        const wizard = Array.isArray(res) ? res[0] : res;
        const execute = () => client.call("base_import.import", "execute_import", [[wizard], matrix.fields, matrix.columns, options], { dryrun }, context);
        try {
          return await execute();
        } catch (e) {
          if (dryrun || e.title !== "Network error") throw e;
          return recover(model, wizard, execute);
        }
      }
      if (dryrun) return { ids: [], messages: [], noDryRun: true };
      // load() takes typed values only through its string converters: same strings work.
      return client.call(model, "load", [matrix.fields, rows], {}, { import_file: true, ...context });
    }

    /* The connection dropped while Odoo was importing a batch: was it saved? Odoo dates the
     * records it creates, so look for records this user created since the batch's wizard. None:
     * the batch never arrived, send it again. Some: keep them (they are counted and undoable). */
    async function recover(model, wizard, execute) {
      await new Promise((r) => setTimeout(r, 1000));
      const [w] = await client.call("base_import.import", "search_read", [[["id", "=", wizard]], ["create_date", "create_uid"]]);
      const uid = Array.isArray(w.create_uid) ? w.create_uid[0] : w.create_uid;
      const ids = await client.call(model, "search", [[["create_date", ">=", w.create_date], ["create_uid", "=", uid]]], { order: "id" }, { active_test: false });
      if (!ids.length) return execute();
      return { ids, recovered: true, messages: [{ type: "warning", message: `The connection dropped during the import; Odoo had saved ${ids.length} record${ids.length > 1 ? "s" : ""} of this batch. Check the batch's rows.` }] };
    }

    /* Run (or dry-run) the planned import.
     * Returns {ok, dryrun, created: [ids], updated: [ids], deps: [{relation, ids}], errors: [{row, line, message}], warnings, batchesDone} */
    // context: extra context for the import calls, e.g. {tracking_disable: true} (no chatter logging).
    async function run(job, analysis, { dryrun = false, batchSize = 500, onProgress, signal, context = {} } = {}) {
      const result = { ok: true, dryrun, created: [], updated: [], deps: [], createdRecords: [], errors: [], warnings: [], batchesDone: 0, noDryRun: false };
      const toCreate = NS.plan.toCreate(job);
      const created = new Map();
      const placeholder = new Map();

      if (toCreate.length && dryrun) {
        for (const relation of new Set(toCreate.map((c) => c.relation))) {
          const ids = await client.call(relation, "search", [[]], { limit: 1 });
          if (ids.length) placeholder.set(relation, ids[0]);
        }
      } else if (toCreate.length) {
        const byRelation = new Map();
        let n = 0;
        const done = (c, id) => {
          created.set(`${c.relation}\u0000${c.name.trim().toLowerCase()}`, id);
          result.createdRecords.push({ relation: c.relation, name: c.name, id });
          if (!byRelation.has(c.relation)) byRelation.set(c.relation, []);
          byRelation.get(c.relation).push(id);
        };
        // 200 at a time with create([{name}]); one by one with name_create when that fails
        // (a model without a "name" field, or one bad value to pinpoint).
        const groups = new Map();
        for (const c of toCreate) {
          if (!groups.has(c.relation)) groups.set(c.relation, []);
          groups.get(c.relation).push(c);
        }
        for (const [relation, list] of groups) {
          for (let i = 0; i < list.length; i += 200) {
            if (signal && signal.aborted) {
              result.ok = false;
              result.cancelled = true;
              break;
            }
            if (onProgress) onProgress({ phase: "create", done: n, total: toCreate.length });
            const part = list.slice(i, i + 200);
            let ids = null;
            try {
              ids = await client.call(relation, "create", [part.map((c) => ({ name: c.name }))]);
            } catch {
              ids = null;
            }
            if (Array.isArray(ids) && ids.length === part.length) part.forEach((c, k) => done(c, ids[k]));
            else {
              for (const c of part) {
                try {
                  const [id] = await client.call(relation, "name_create", [c.name]);
                  done(c, id);
                } catch (e) {
                  result.ok = false;
                  result.errors.push({ row: null, line: null, message: `Couldn't create ${relation} “${c.name}”: ${e.message}` });
                }
              }
            }
            n += part.length;
          }
        }
        result.deps = [...byRelation].map(([relation, ids]) => ({ relation, ids }));
        if (!result.ok) return result;
      }

      // Updates and creations go in separate passes when rows are matched by a key, so the
      // ".id" column is only sent where every row has one. Records linking to new records of the
      // file go last (a dry run leaves these links empty: every batch is rolled back).
      const passes = NS.plan.needsDbId(job) ? ["update", "create"] : [null];
      let steps = passes.map((part) => ({ part }));
      let first = null;
      if (!dryrun && analysis.inFile && analysis.inFile.size) {
        const xmlids = NS.plan.xmlids(job, analysis, Date.now().toString(36));
        // The linked updates after the linked creations: nothing links to a record being updated.
        steps = [...passes.map((part) => ({ part, linked: false })), ...passes.slice().reverse().map((part) => ({ part, linked: true }))].map((step) => ({ ...step, xmlids }));
        first = steps.map((step) => NS.plan.build(job, analysis, { created, placeholder, ...step }));
        if (first.some((m) => m.mixed)) {
          // Rounds: a record linking to a new record of the file is built once its id is known.
          const levels = [...new Set([0, ...analysis.levels.values()])].sort((a, b) => a - b);
          steps = levels.flatMap((level) => passes.map((part) => ({ level, part })));
          first = null;
        }
      }
      first = first || steps.map((step) => NS.plan.build(job, analysis, { created, placeholder, ...step }));
      const ids = new Map(); // source row -> id of its record (rounds)
      const total = first.reduce((n, m) => n + m.rows.length, 0);
      let done = 0;
      let stop = false;
      for (const [n, step] of steps.entries()) {
        if (!first[n].rows.length) continue;
        const matrix = step.level ? NS.plan.build(job, analysis, { created, placeholder, ...step, rowIds: ids }) : first[n];
        if (step.level && !dryrun) {
          const lost = [...analysis.inFile].filter(([at, t]) => !ids.has(t) && analysis.levels.get(Number(at.split(":")[1])) === step.level);
          if (lost.length) {
            const rows = [...new Set(lost.map(([at]) => Number(at.split(":")[1])))];
            result.warnings.push({ row: rows[0], line: job.table.lines[rows[0]], message: `${lost.length} link${lost.length > 1 ? "s" : ""} to records of this file couldn't be set (the connection dropped while they were imported); rows ${rows.slice(0, 5).map((r) => job.table.lines[r]).join(", ")}${rows.length > 5 ? "…" : ""}.` });
          }
        }
        for (const part of batches(matrix.groups, batchSize)) {
          if (signal && signal.aborted) {
            result.ok = false;
            result.cancelled = true;
            stop = true;
            break;
          }
          if (onProgress) onProgress({ phase: dryrun ? "check" : "import", done, total });
          const rows = matrix.rows.slice(part[0].out[0], part[part.length - 1].out[1]);
          let res;
          try {
            res = await runBatch(job.model, matrix, rows, dryrun, context);
          } catch (e) {
            result.ok = false;
            result.errors.push({ row: part[0].src[0], line: job.table.lines[part[0].src[0]], message: e.message, title: e.title });
            stop = true;
            break;
          }
          if (res.noDryRun) {
            result.noDryRun = true;
            stop = true;
            break;
          }
          // Map Odoo's message rows (0-based in the batch) back to sheet rows.
          const outToSrc = [];
          for (const g of part) for (let k = 0; k < g.out[1] - g.out[0]; k++) outToSrc.push(g.src[k] ?? g.src[0]);
          let batchFailed = false;
          for (const msg of res.messages || []) {
            const at = msg.rows ? msg.rows.from : typeof msg.record === "number" ? msg.record : null;
            const row = at !== null && at !== undefined && outToSrc[at] !== undefined ? outToSrc[at] : null;
            const entry = { row, line: row !== null ? job.table.lines[row] : null, message: msg.message, field: msg.field_name || msg.field || null };
            if (msg.type === "error") {
              batchFailed = true;
              result.errors.push(entry);
            } else result.warnings.push(entry);
          }
          if (batchFailed || !res.ids) {
            result.ok = false;
            if (!dryrun) {
              stop = true; // keep going on a dry run to collect every error
              break;
            }
          } else if (!dryrun && res.recovered) {
            result.created.push(...res.ids); // found after a dropped connection: new records of this batch
            // Odoo numbers new records in order: a batch of new records only maps back to its rows.
            if (res.ids.length === part.length && part.every((g) => !NS.plan.existingTarget(job, g.src[0]))) part.forEach((g, k) => ids.set(g.src[0], res.ids[k]));
          } else if (!dryrun) {
            part.forEach((g, k) => {
              const id = res.ids[k];
              if (!id) return;
              ids.set(g.src[0], id);
              const target = NS.plan.existingTarget(job, g.src[0]);
              (target ? result.updated : result.created).push(id);
            });
          }
          done += rows.length;
          result.batchesDone++;
        }
        if (stop) break;
      }
      // Nothing saved: the linked records created for this import would only be orphans.
      if (!dryrun && !result.created.length && !result.updated.length && result.deps.length) {
        for (const d of [...result.deps].reverse()) {
          try {
            await client.call(d.relation, "unlink", [d.ids]);
          } catch {
            // still listed in the result: undo can retry
            continue;
          }
          d.ids = [];
        }
        result.deps = result.deps.filter((d) => d.ids.length);
        result.createdRecords = result.deps.length ? result.createdRecords : [];
      }
      if (onProgress) onProgress({ phase: "done", done, total });
      return result;
    }

    // Undo: delete what an import created (records, then the many2one records it created).
    // A stock count is undone by restoring the counts (see inventory.undo).
    async function undo(entry) {
      if (entry.count) return NS.inventory.undo(client, entry);
      const errors = [];
      if (entry.created.length) {
        try {
          await client.call(entry.model, "unlink", [entry.created]);
        } catch (e) {
          errors.push(e.message);
        }
      }
      for (const d of [...(entry.deps || [])].reverse()) {
        try {
          await client.call(d.relation, "unlink", [d.ids]);
        } catch (e) {
          errors.push(e.message);
        }
      }
      return errors;
    }

    return { run, undo, baseImportAvailable, batch: runBatch };
  }

  NS.execute = { createExecutor, batches, base64 };
})();
