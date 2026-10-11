/* Odoo Import Export: an import template for any model.
 *
 * Columns: the required fields Odoo can't fill in itself, then the fields of the model's form
 * view, then the columns of its lines (Order Lines / Product, Quantity…) when it has some.
 * Headers are field labels, which the import maps back automatically. The Data sheet stays
 * empty (sample rows get imported by mistake); dropdowns list the valid choices, and the Help
 * sheet says what each column takes, with an example from the database.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const MAX_COLUMNS = 24;
  const MAX_DROPDOWN = 300; // link dropdowns only for small related lists (countries, units, tags…)
  const SKIP = new Set(["one2many", "binary", "html", "json", "properties", "properties_definition", "reference", "many2one_reference"]);
  const TRUTHY = /^(1|true|True)$/;

  // Fields shown on the form (outside the lines' own sub-views), in order.
  async function formFields(client, model) {
    let arch = null;
    try {
      const res = await client.call(model, "get_views", [[[false, "form"]]], {});
      arch = res && res.views && res.views.form && res.views.form.arch;
    } catch {
      return [];
    }
    if (!arch) return [];
    const root = new DOMParser().parseFromString(arch, "text/xml").documentElement;
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.tagName === "field") {
          let mods = {};
          try {
            mods = JSON.parse(c.getAttribute("modifiers") || "{}");
          } catch {
            mods = {};
          }
          const hidden = TRUTHY.test(c.getAttribute("invisible") || "") || mods.invisible === true;
          if (!hidden) out.push(c.getAttribute("name"));
          continue; // don't descend into a field's own sub-views
        }
        walk(c);
      }
    };
    walk(root);
    return [...new Set(out)];
  }

  function typeText(f, relationLabel) {
    switch (f.type) {
      case "char":
      case "text":
        return "Text";
      case "integer":
        return "Whole number";
      case "float":
      case "monetary":
        return "Number";
      case "boolean":
        return "Yes / No";
      case "date":
        return "Date";
      case "datetime":
        return "Date and time";
      case "selection":
        return "Choice";
      case "many2one":
        return `Link to ${relationLabel}`;
      case "many2many":
        return `Links to ${relationLabel} (comma-separated)`;
      default:
        return f.type;
    }
  }

  /* -> {sheets, fileName, templates: [{label, url}]} for xlsxwriter.book. */
  async function build(client, schemas, model, modelName) {
    const schema = await schemas.load(model);
    const fields = schema.fields;
    const importable = (n) => fields.has(n) && fields.get(n).importable && !SKIP.has(fields.get(n).type);
    const required = [...fields.values()].filter((f) => f.required && importable(f.name)).map((f) => f.name);
    const defaults = await schemas.defaults(model, required);
    const mustFill = required.filter((n) => !(n in defaults) || defaults[n] === false || defaults[n] === null);
    const onForm = (await formFields(client, model)).filter(importable);
    const first = fields.has("name") && importable("name") ? ["name"] : [];
    const names = [...new Set([...first, ...mustFill, ...onForm])].slice(0, MAX_COLUMNS);
    const paths = names.map((n) => [n]);

    // Lines: the form's first one2many with a lines table (order_line, invoice_line_ids…).
    const o2m = [...fields.values()].filter((f) => f.type === "one2many" && f.importable && /line/.test(f.name));
    const lines = o2m.length ? o2m.find((f) => /^(order_line|invoice_line_ids|line_ids)$/.test(f.name)) || o2m[0] : null;
    if (lines) {
      const sub = await schemas.load(lines.relation);
      const linePaths = (await NS.export.linePaths(client, schemas, model, lines))
        .filter((p) => sub.fields.has(p[1]) && sub.fields.get(p[1]).importable && !SKIP.has(sub.fields.get(p[1]).type))
        .slice(0, 6);
      paths.push(...linePaths);
    }

    const cols = [];
    for (const path of paths) {
      const fs = await schemas.resolvePath(model, path);
      if (!fs) continue;
      cols.push({ path, fields: fs, field: fs[fs.length - 1], header: fs.map((f) => f.string).join(" / ") });
    }
    // Two fields with the same label would be ambiguous: add the technical name.
    const seen = new Map();
    for (const c of cols) seen.set(c.header, (seen.get(c.header) || 0) + 1);
    for (const c of cols) if (seen.get(c.header) > 1) c.header = `${c.header} (${c.path.join("/")})`;

    // Example values from the most recent record, and names of small related lists.
    let example = [];
    try {
      const ids = await client.call(model, "search", [[]], { limit: 1, order: "id desc" });
      if (ids.length) example = (await client.call(model, "export_data", [ids, cols.map((c) => c.path.join("/"))], {}, { import_compat: true })).datas[0] || [];
    } catch {
      example = [];
    }
    const relationNames = new Map();
    for (const c of cols) {
      const f = c.field;
      if (!["many2one", "many2many"].includes(f.type) || relationNames.has(f.relation)) continue;
      try {
        const n = await client.call(f.relation, "search_count", [[]]);
        const rows = await client.call(f.relation, "search_read", [[], ["display_name"]], { limit: n <= MAX_DROPDOWN ? MAX_DROPDOWN : 5, order: "id" });
        relationNames.set(f.relation, { names: rows.map((r) => r.display_name), all: n <= MAX_DROPDOWN });
      } catch {
        relationNames.set(f.relation, { names: [], all: false });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const validations = [];
    const help = cols.map((c, i) => {
      const f = c.field;
      const rel = f.relation ? relationNames.get(f.relation) : null;
      let allowed = "";
      if (f.type === "selection") {
        const labels = (f.selection || []).map(([, l]) => l);
        allowed = labels.join(", ");
        validations.push({ col: i, values: labels });
      } else if (f.type === "boolean") {
        allowed = "Yes or No";
        validations.push({ col: i, values: ["Yes", "No"] });
      } else if (f.type === "many2one" && rel) {
        allowed = rel.names.length ? `A name, e.g. ${rel.names.slice(0, 5).join(", ")}${rel.all ? "" : "…"}` : "A name";
        if (rel.all && rel.names.length) validations.push({ col: i, values: rel.names });
      } else if (f.type === "many2many" && rel) {
        allowed = rel.names.length ? `Names separated by commas, e.g. ${rel.names.slice(0, 2).join(", ")}` : "Names separated by commas";
      } else if (f.type === "date") allowed = `e.g. ${today}`;
      else if (f.type === "datetime") allowed = `e.g. ${today} 14:30`;
      else if (["float", "monetary"].includes(f.type)) allowed = "e.g. 1234.50";
      else if (f.type === "integer") allowed = "e.g. 12";
      const isLine = c.fields.length > 1;
      const req = (isLine ? f.required : mustFill.includes(c.path[0])) ? "Yes" : "";
      const ex = example[i] === false || example[i] === undefined ? "" : String(example[i]);
      return [c.header, c.path.join("/"), typeText(f, f.relation ? c.field.string : ""), req, allowed, ex];
    });

    const notes = [
      [],
      ["How to fill it"],
      ["One row per record. Required columns (Required = Yes) must be filled; leave the others empty if you don't need them."],
      ["Links (customer, country, product…) take the record's name; choices and yes/no columns have a dropdown."],
      ...(lines ? [[`${lines.string}: one row per line. Put the first line on the record's row and the next lines on the rows below it, with the record's own columns left empty.`]] : []),
      ["To update existing records instead, export them with Export › For re-importing, edit, and import that file."],
      ["Import it with Odoo Import Export: Import › drop the file. The columns are matched automatically."],
    ];

    let templates = [];
    try {
      templates = ((await client.call(model, "get_import_templates", [])) || []).map((t) => ({ label: t.label, url: t.template }));
    } catch {
      templates = [];
    }

    return {
      fileName: `${modelName.replace(/[\\/:*?"<>|]+/g, " ")} import template.xlsx`,
      templates,
      columns: cols.map((c) => c.header),
      sheets: [
        { name: "Data", headers: cols.map((c) => c.header), rows: [], types: cols.map(() => "text"), validations, filter: false },
        { name: "Help", headers: ["Column", "Technical name", "Type", "Required", "Allowed values", "Example from your database"], rows: [...help, ...notes], maxWidth: 70, filter: false },
      ],
    };
  }

  NS.template = { build, formFields };
})();
