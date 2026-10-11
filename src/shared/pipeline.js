/* Odoo Import Export: the steps between "a table" and "a job ready for review", shared by the
 * panel and the end-to-end tests.
 *
 *   deps = {client, schemas, resolver, memory, onProgress}
 *   memory: {headers(model) -> Map, values(relation) -> Map}   (see the panel's storage)
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});

  // shared.schemas: reuse a schema cache (field definitions don't depend on the client).
  function makeDeps(client, memory = {}, shared = {}) {
    const schemas = shared.schemas || NS.schema.createSchemaCache(client);
    return {
      client,
      schemas,
      resolver: NS.m2o.createResolver(client, schemas),
      executor: NS.execute.createExecutor(client),
      memory: { headers: async () => new Map(), values: async () => new Map(), ...memory },
      onProgress: null,
    };
  }

  // Profile every column and map columns to fields.
  async function prepare(deps, model, table, { dateOrder } = {}) {
    const job = NS.plan.newJob(model, table);
    job.profiles = table.headers.map((_, c) => NS.profile.profileColumn(table.rows.map((r) => r[c]), { dateOrder }));
    const fields = await deps.schemas.importable(model);
    const mapping = await NS.columns.automap({
      headers: table.headers,
      profiles: job.profiles,
      fields,
      subFields: async (f) => deps.schemas.importable(f.relation),
      memory: await deps.memory.headers(model),
    });
    job.mapping = mapping;
    for (const m of job.mapping) {
      if (m.path) await setPath(deps, job, m.col, m.path, { status: m.status });
      else m.fields = null;
    }
    await updateRequired(deps, job);
    return job;
  }

  // Point a column at a field path (or null to ignore it).
  async function setPath(deps, job, col, path, { status = "manual" } = {}) {
    const m = job.mapping[col];
    if (!path) {
      Object.assign(m, { path: null, fields: null, status: "ignored", confirmed: true });
      return;
    }
    const fields = await deps.schemas.resolvePath(job.model, path);
    if (!fields) {
      Object.assign(m, { path: null, fields: null, status: "none" });
      return;
    }
    // Another column on the same path loses it.
    const key = path.join("/");
    for (const other of job.mapping) {
      if (other !== m && other.path && other.path.join("/") === key) Object.assign(other, { path: null, fields: null, status: "none" });
    }
    Object.assign(m, { path, fields, status, confirmed: status === "manual" ? true : m.confirmed });
  }

  // Required fields with neither a column nor an Odoo default value.
  async function updateRequired(deps, job) {
    const s = await deps.schemas.load(job.model);
    const required = [...s.fields.values()].filter((f) => f.required && f.importable);
    const mapped = new Set(job.mapping.filter((m) => m.path).map((m) => m.path[0]));
    const unmapped = required.filter((f) => !mapped.has(f.name));
    const defaults = await deps.schemas.defaults(job.model, required.map((f) => f.name));
    job.requiredMissing = unmapped.filter((f) => !hasDefault(f, defaults));
    // Odoo's defaults for required fields, as import values: an empty cell on a new record gets
    // them (an empty Company column must not leave the order without a company).
    job.fieldDefaults = {};
    for (const f of required) {
      if (!hasDefault(f, defaults)) continue;
      const v = defaults[f.name];
      if (f.type === "many2one") job.fieldDefaults[f.name] = String(Array.isArray(v) ? v[0] : v);
      else if (f.type === "boolean") job.fieldDefaults[f.name] = v ? "1" : "0";
      else if (["char", "text", "selection", "integer", "float", "monetary", "date", "datetime"].includes(f.type)) job.fieldDefaults[f.name] = String(v);
    }
  }

  // A real default: not null/empty ("" for a text, [] for links), and not False unless a checkbox.
  const hasDefault = (f, defaults) => {
    if (!(f.name in defaults)) return false;
    const v = defaults[f.name];
    if (v === null || v === "" || (Array.isArray(v) && !v.length)) return false;
    return v !== false || f.type === "boolean";
  };

  /* Can records of `relation` be created from a name alone (the "Create" choice)?
   * Not when Odoo needs other values it has no default for (a country needs its code),
   * or when the user may not create them. Returns {ok, missing: [labels], noRights}. */
  async function creatable(deps, relation) {
    const s = await deps.schemas.load(relation);
    const nameField = ["name", "complete_name"].find((n) => s.fields.has(n));
    const required = [...s.fields.values()].filter((f) => f.required && f.importable && f.store && f.name !== nameField);
    const defaults = await deps.schemas.defaults(relation, required.map((f) => f.name));
    const missing = required.filter((f) => !hasDefault(f, defaults)).map((f) => f.string);
    let allowed = true;
    try {
      allowed = await deps.client.call(relation, "has_access", [[], "create"]); // Odoo 18+, on an empty recordset
    } catch {
      try {
        allowed = await deps.client.call(relation, "check_access_rights", ["create", false]);
      } catch {
        allowed = true; // can't tell: let the import report it
      }
    }
    return { ok: !!allowed && !missing.length, missing, noRights: !allowed };
  }

  // Suggest a record key and look values up; resolve every relational column.
  async function resolve(deps, job) {
    const keyNames = await deps.schemas.keyFields(job.model);
    job.keyOptions = NS.records.suggestKeys(NS.plan.active(job), keyNames, job.table);
    if (job.key && !job.keyOptions.some((k) => k.col === job.key.col)) job.key = null;
    if (job.key === null && !job.keyChosen) {
      const best = job.keyOptions.find((k) => k.rank < 50 && k.unique);
      job.key = best ? { col: best.col, field: best.field, label: best.label, mode: "update" } : null;
    }
    await NS.plan.resolveAll(job, {
      client: deps.client,
      schemas: deps.schemas,
      resolver: deps.resolver,
      valueMemory: deps.memory.values,
      onProgress: deps.onProgress,
      signal: deps.signal,
    });
    job.createInfo = new Map();
    for (const r of job.rel.values()) {
      if (!job.createInfo.has(r.field.relation)) job.createInfo.set(r.field.relation, await creatable(deps, r.field.relation));
    }
  }

  NS.pipeline = { makeDeps, prepare, setPath, updateRequired, resolve, creatable };
})();
