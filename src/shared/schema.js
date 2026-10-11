/* Odoo Import Export: model schemas.
 *
 * Works on any model: everything comes from fields_get, read once per model in the
 * user's language and in en_US (headers are often English even when the UI isn't).
 * `client` is anything with call(model, method, args, kwargs, context) -> Promise.
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  const MAGIC = new Set(["create_uid", "create_date", "write_uid", "write_date", "__last_update", "id", "display_name"]);
  const UNSUPPORTED = new Set(["properties", "properties_definition", "json", "many2one_reference", "reference"]);
  const ATTRS = ["string", "type", "relation", "required", "readonly", "selection", "store", "translate", "help"];

  // Pseudo fields every model accepts in an import.
  const ID_FIELD = { name: "id", string: "External ID", stringEn: "External ID", type: "id", required: false, readonly: false, importable: true };
  const DBID_FIELD = { name: ".id", string: "Database ID", stringEn: "Database ID", type: "dbid", required: false, readonly: false, importable: true };

  function createSchemaCache(client) {
    const cache = new Map();

    async function load(model) {
      if (cache.has(model)) return cache.get(model);
      const promise = (async () => {
        const [local, en] = await Promise.all([
          client.call(model, "fields_get", [], { attributes: ATTRS }),
          client.call(model, "fields_get", [], { attributes: ["string", "selection"] }, { lang: "en_US" }).catch(() => ({})),
        ]);
        const fields = new Map();
        for (const [name, f] of Object.entries(local)) {
          const field = {
            name,
            string: f.string || name,
            stringEn: (en[name] && en[name].string) || f.string || name,
            type: f.type,
            relation: f.relation || null,
            required: !!f.required,
            readonly: !!f.readonly,
            store: f.store !== false,
            translate: !!f.translate,
            help: f.help || "",
            selection: Array.isArray(f.selection) ? f.selection : null,
            selectionEn: en[name] && Array.isArray(en[name].selection) ? en[name].selection : null,
          };
          // Same rule as Odoo's own import (base_import.get_fields_tree): no magic or readonly fields.
          field.importable = !MAGIC.has(name) && !field.readonly && !UNSUPPORTED.has(field.type);
          fields.set(name, field);
        }
        return { model, fields };
      })();
      cache.set(model, promise);
      promise.catch(() => cache.delete(model));
      return promise;
    }

    // Fields offered for mapping: External ID first, then importable fields by label.
    async function importable(model) {
      const s = await load(model);
      const list = [...s.fields.values()].filter((f) => f.importable);
      list.sort((a, b) => a.string.localeCompare(b.string));
      return [ID_FIELD, ...list, DBID_FIELD];
    }

    // Resolve a mapping path such as ["order_line", "product_id"] to its field objects.
    async function resolvePath(model, path) {
      const out = [];
      let current = model;
      for (const name of path) {
        if (name === "id") {
          out.push(ID_FIELD);
          break;
        }
        if (name === ".id") {
          out.push(DBID_FIELD);
          break;
        }
        const s = await load(current);
        const f = s.fields.get(name);
        if (!f) return null;
        out.push(f);
        current = f.relation;
      }
      return out;
    }

    // Required fields that get a value anyway: Odoo defaults for this user/company.
    async function defaults(model, names) {
      if (!names.length) return {};
      try {
        return (await client.call(model, "default_get", [names])) || {};
      } catch {
        return {};
      }
    }

    // Alternate keys for many2one lookups and record matching on `model`.
    async function keyFields(model) {
      const s = await load(model);
      const hinted = NS.synonyms.MODEL_KEYS[model];
      const names = hinted || NS.synonyms.GENERIC_KEYS;
      return names.filter((n) => {
        const f = s.fields.get(n);
        return f && f.store && ["char", "text"].includes(f.type);
      });
    }

    return { load, importable, resolvePath, defaults, keyFields };
  }

  NS.schema = { createSchemaCache, ID_FIELD, DBID_FIELD };
})();
