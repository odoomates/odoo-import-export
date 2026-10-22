/* Odoo Import Export: match file rows to existing records (create or update?).
 *
 * The key is a mapped column: External ID, Database ID, an alternate key of the model
 * (default_code, email, vat, code, ...) or the name. Odoo handles External/Database IDs
 * natively; for other keys we look the values up and send the matched ids as ".id".
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const lower = (v) => String(v ?? "").trim().toLowerCase();

  /* Candidate keys among the mapped top-level columns, best first.
   * mapping: [{col, path, fields}], keyNames: alternate key fields of the model. */
  function suggestKeys(mapping, keyNames, table) {
    const out = [];
    for (const m of mapping) {
      if (!m.path || m.path.length !== 1 || !m.fields) continue;
      const name = m.path[0];
      let rank = null;
      if (name === "id") rank = 0;
      else if (name === ".id") rank = 1;
      else if (keyNames.includes(name)) rank = 2 + keyNames.indexOf(name);
      else if (name === "name" || name === "complete_name") rank = 50;
      if (rank === null) continue;
      const values = table.rows.map((r) => r[m.col]).filter(Boolean);
      const unique = new Set(values.map(lower)).size === values.length;
      out.push({ col: m.col, field: name, label: m.fields[0].string, rank: rank + (unique ? 0 : 100), unique, filled: values.length });
    }
    return out.sort((a, b) => a.rank - b.rank);
  }

  // Look up existing records by key value: Map lower(value) -> [{id, label}].
  async function findExisting(client, model, field, values) {
    const distinct = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
    const out = new Map();
    const push = (v, rec) => {
      const k = lower(v);
      if (!out.has(k)) out.set(k, []);
      if (!out.get(k).some((r) => r.id === rec.id)) out.get(k).push(rec);
    };
    for (let i = 0; i < distinct.length; i += 200) {
      const part = distinct.slice(i, i + 200);
      if (field === "id") {
        // Only a full External ID (module.name) matches: "x" is not "__import__.x".
        const full = part.filter(splitXmlid);
        if (!full.length) continue;
        const domain = [["model", "=", model], ...Array(full.length - 1).fill("|"), ...full.flatMap((v) => {
          const [module, name] = splitXmlid(v);
          return ["&", ["module", "=", module], ["name", "=", name]];
        })];
        const rows = await client.call("ir.model.data", "search_read", [domain, ["module", "name", "res_id"]]);
        for (const r of rows) {
          const id = `${r.module}.${r.name}`;
          for (const v of full) if (v === id) push(v, { id: r.res_id, label: id });
        }
      } else if (field === ".id") {
        const ids = part.filter((v) => /^\d+$/.test(v)).map(Number);
        const rows = await client.call(model, "search_read", [[["id", "in", ids]], ["display_name"]], {}, { active_test: false });
        for (const r of rows) push(String(r.id), { id: r.id, label: r.display_name });
      } else {
        const variants = [...new Set(part.flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()]))];
        const rows = await client.call(model, "search_read", [[[field, "in", variants]], ["display_name", field]], {}, { active_test: false });
        for (const r of rows) for (const v of part) if (lower(r[field]) === lower(v)) push(v, { id: r.id, label: r.display_name });
      }
    }
    return out;
  }

  // "module.name" -> [module, name]; null when a part is missing.
  function splitXmlid(v) {
    const s = String(v ?? "").trim();
    const dot = s.indexOf(".");
    return dot > 0 && dot < s.length - 1 && !/\s/.test(s) ? [s.slice(0, dot), s.slice(dot + 1)] : null;
  }

  /* The names among `modules` that are Odoo modules (installed or not): a new record must not
   * take one, the module's updates would manage it. Read from the modules' own External IDs
   * (base.module_<name>), which every user can read. */
  async function realModules(client, modules) {
    const names = [...new Set(modules)].filter((m) => !m.startsWith("__"));
    const out = new Set();
    for (let i = 0; i < names.length; i += 200) {
      const part = names.slice(i, i + 200).map((m) => `module_${m}`);
      const rows = await client.call("ir.model.data", "search_read", [[["module", "=", "base"], ["model", "=", "ir.module.module"], ["name", "in", part]], ["name"]]);
      for (const r of rows) out.add(r.name.slice("module_".length));
    }
    return out;
  }

  NS.records = { suggestKeys, findExisting, splitXmlid, realModules, lower };
})();
