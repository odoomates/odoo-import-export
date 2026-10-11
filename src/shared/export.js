/* Odoo Import Export: export records.
 *
 * Two purposes, one engine (Odoo's own export_data, in its import-compatible mode: links
 * as names, tags in one cell, order lines on extra rows):
 *   data      the columns of the model's list view, labels as headers
 *   reimport  External ID + the editable fields, technical names as headers: the file goes
 *             back through the import and updates the same records
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const CHUNK = 2000;
  const TRUTHY = /^(1|true|True)$/;

  // Visible column fields of a <list>/<tree> element (Odoo 19 also groups them in <column>).
  // keepHidden(name): also keep this optional="hide" column.
  function listColumns(list, keepHidden = () => false) {
    const fields = [];
    for (const el of list.children) {
      if (el.tagName === "column" && !TRUTHY.test(el.getAttribute("column_invisible") || "")) fields.push(...[...el.children].filter((c) => c.tagName === "field"));
      else if (el.tagName === "field") fields.push(el);
    }
    // Odoo 16 moves invisible="1" into a JSON "modifiers" attribute; 17+ keep the attributes.
    const modifiers = (el) => {
      try {
        return JSON.parse(el.getAttribute("modifiers") || "{}");
      } catch {
        return {};
      }
    };
    return fields
      .filter((el) => !TRUTHY.test(el.getAttribute("column_invisible") || "") && !TRUTHY.test(el.getAttribute("invisible") || ""))
      .filter((el) => modifiers(el).column_invisible !== true && modifiers(el).invisible !== true)
      .filter((el) => (el.getAttribute("optional") !== "hide" || keepHidden(el.getAttribute("name"))) && el.getAttribute("widget") !== "handle")
      .map((el) => el.getAttribute("name"));
  }

  async function viewArch(client, model, types) {
    for (const type of types) {
      try {
        const res = await client.call(model, "get_views", [[[false, type]]], {});
        const view = res && res.views && res.views[type];
        if (view && view.arch) return new DOMParser().parseFromString(view.arch, "text/xml").documentElement;
      } catch {
        // try the next view type
      }
    }
    return null;
  }

  // Field names shown as columns in the model's default list view (Odoo 16: "tree").
  async function listViewFields(client, model) {
    const root = await viewArch(client, model, ["list", "tree"]);
    return root ? listColumns(root) : [];
  }

  // one2many columns put every line on its own row, and json/binary cells aren't readable:
  // left out unless added on purpose.
  const SKIP = new Set(["one2many", "json", "binary", "properties", "properties_definition"]);

  /* Columns for the lines of a one2many field (Order Lines -> Product, Quantity, Unit Price…):
   * the lines table of the record's form view, else the default list view of the lines'
   * model. Links hidden by default are kept (Odoo 19 hides a sale line's Product: it shows in
   * the description); the link back to the parent (order_id), screen-only computed fields
   * (not stored) and unreadable types are left out. */
  async function linePaths(client, schemas, model, o2m) {
    let names = [];
    const sub = await schemas.load(o2m.relation);
    const isLink = (n) => sub.fields.has(n) && sub.fields.get(n).type === "many2one";
    const form = await viewArch(client, model, ["form"]);
    const field = form && [...form.getElementsByTagName("field")].find((el) => el.getAttribute("name") === o2m.name);
    const list = field && [...field.children].find((el) => el.tagName === "list" || el.tagName === "tree");
    if (list) names = listColumns(list, isLink);
    if (!names.length) names = await listViewFields(client, o2m.relation);
    const keep = (n) => {
      const f = sub.fields.get(n);
      return f && f.store && !SKIP.has(f.type) && !(f.type === "many2one" && f.relation === model);
    };
    names = [...new Set(names)].filter(keep).slice(0, 10);
    if (!names.length) names = [sub.fields.has("name") ? "name" : "display_name"];
    return names.map((n) => [o2m.name, n]);
  }

  // Default columns for a purpose, as paths: [["id"], ["name"], ["country_id"], ...].
  async function defaultPaths(client, schemas, model, purpose) {
    const s = await schemas.load(model);
    const listed = [...new Set(await listViewFields(client, model))].filter((n) => s.fields.has(n) && !SKIP.has(s.fields.get(n).type));
    let names;
    if (purpose === "reimport") {
      const editable = (n) => s.fields.get(n).importable;
      const required = [...s.fields.values()].filter((f) => f.required && f.importable && f.type !== "one2many").map((f) => f.name);
      const name = s.fields.has("name") && editable("name") ? ["name"] : [];
      names = ["id", ...new Set([...name, ...listed.filter(editable), ...required])];
    } else {
      names = listed.length ? listed : s.fields.has("name") ? ["name"] : ["display_name"];
    }
    return names.map((n) => [n]);
  }

  const TYPE = { integer: "number", float: "number", monetary: "number", boolean: "boolean", date: "date", datetime: "datetime" };

  /* Describe columns: [{path, fields, label, header, type}]. Unknown paths are dropped. */
  async function describe(schemas, model, paths, purpose) {
    const out = [];
    for (const path of paths) {
      const fields = await schemas.resolvePath(model, path);
      if (!fields) continue;
      const last = fields[fields.length - 1];
      const label = fields.map((f) => f.string).join(" / ");
      out.push({ path, fields, label, header: purpose === "reimport" ? path.join("/") : label, type: TYPE[last.type] || "text" });
    }
    return out;
  }

  async function count(client, model, { archived = false, domain = [] } = {}) {
    return client.call(model, "search_count", [domain], {}, archived ? { active_test: false } : {});
  }

  /* Fetch the rows. columns: from describe(). Returns {headers, types, rows, records}. */
  async function fetchRows(client, model, columns, { archived = false, domain = [], onProgress, signal } = {}) {
    const ctx = archived ? { active_test: false } : {};
    const ids = await client.call(model, "search", [domain], { order: "id" }, ctx);
    const fields = columns.map((c) => c.path.join("/"));
    const rows = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      NS.rpc.throwIfAborted(signal);
      if (onProgress) onProgress({ done: i, total: ids.length });
      const res = await client.call(model, "export_data", [ids.slice(i, i + CHUNK), fields], {}, { ...ctx, import_compat: true });
      for (const r of res.datas) rows.push(r);
    }
    if (onProgress) onProgress({ done: ids.length, total: ids.length });
    return { headers: columns.map((c) => c.header), types: columns.map((c) => c.type), rows, records: ids.length };
  }

  // Cells as plain text for CSV: no "False" for empty values.
  function csvCell(v, type) {
    if (v === null || v === undefined) return "";
    if (v === false) return type === "boolean" ? "False" : "";
    if (v === true) return "True";
    return String(v);
  }

  async function toBlob({ headers, types, rows }, format, sheetName) {
    if (format === "csv") {
      const text = NS.csv.serialize([headers, ...rows.map((r) => r.map((v, c) => csvCell(v, types[c])))]);
      return new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    }
    return NS.xlsxwriter.workbook({ headers, rows, types, sheetName });
  }

  NS.export = { listViewFields, linePaths, defaultPaths, describe, count, fetchRows, toBlob };
})();
