/* Odoo Import Export: resolve many2one / many2many cell values to record ids.
 *
 * Works on distinct values, not rows, and batches the lookups. For each value:
 *   1. a choice remembered from an earlier import (checked to still exist)
 *   2. a database id (".id" columns) or an external id ("module.name")
 *   3. an exact, case-insensitive match on the record name (display_name / name)
 *   4. an exact match on an alternate key of the comodel (email, code, barcode, ...)
 *   5. otherwise a fuzzy name_search, ranked by string similarity
 * and classifies it:
 *   ok         one record (an archived one is used only when it is the only match)
 *   ambiguous  several records match exactly: the user (or another column) must pick
 *   probable   no exact match, but one close match stands out
 *   missing    nothing close enough; candidates (if any) are suggestions
 */
(() => {
  "use strict";
  const NS = (globalThis.OdooImport = globalThis.OdooImport || {});
  const { similarity, norm } = NS.text;

  const CHUNK = 80;
  const FUZZY_MAX = 300; // distinct values searched fuzzily per column
  const PROBABLE = 0.85;

  const lower = (v) => String(v ?? "").trim().toLowerCase();
  const escapeLike = (v) => String(v).replace(/[\\%_]/g, "\\$&");
  const XMLID = /^[a-z_][\w]*\.[\w.\-]+$/i;

  function chunks(list, n = CHUNK) {
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  function orDomain(leaves) {
    return leaves.length ? [...Array(leaves.length - 1).fill("|"), ...leaves] : [];
  }

  async function pool(items, size, fn, signal) {
    let i = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        if (signal && signal.aborted) return;
        const item = items[i++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  const SMALL = 3000; // comodels up to this size are fuzzy-matched locally

  function createResolver(client, schemas) {
    const ALL = { active_test: false };
    const names = new Map(); // relation -> Promise<[{id, label}] | null>

    // Every active record name of a small comodel, or null when it is too big.
    function allNames(relation) {
      if (!names.has(relation)) {
        names.set(relation, (async () => {
          try {
            const count = await client.call(relation, "search_count", [[]]);
            if (count > SMALL) return null;
            const rows = await client.call(relation, "search_read", [[], ["display_name"]], { limit: SMALL });
            return rows.map((r) => ({ id: r.id, label: r.display_name }));
          } catch {
            return null;
          }
        })());
      }
      return names.get(relation);
    }

    /* relation: comodel name; values: raw strings; mode: "name" | "xmlid" | "dbid";
     * linkFields: comodel many2one fields to read for row-context narrowing;
     * memory: Map lower(value) -> id remembered from earlier imports.
     * Returns Map raw -> {status, id, source, candidates: [{id, label, score, active, links, detail}]}. */
    async function resolve({ relation, values, mode = "name", linkFields = [], memory = new Map(), onProgress, signal }) {
      const check = () => NS.rpc.throwIfAborted(signal);
      const schema = await schemas.load(relation);
      const has = (f) => schema.fields.has(f);
      const keys = await schemas.keyFields(relation);
      const readFields = ["display_name", ...["name", "active", "company_id"].filter(has), ...keys, ...linkFields.filter(has)];
      const distinct = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
      const exact = new Map(distinct.map((v) => [v, new Map()])); // value -> Map(id -> source)
      const records = new Map(); // id -> record
      const add = (v, id, source) => {
        if (!exact.get(v).has(id)) exact.get(v).set(id, source);
      };
      const aliases = NS.synonyms.VALUE_ALIASES[relation] || {};
      const lookup = new Map(distinct.map((v) => [v, aliases[norm(v)] || v]));

      async function searchRead(domain) {
        const rows = await client.call(relation, "search_read", [domain, readFields], { limit: 2000 }, ALL);
        for (const r of rows) records.set(r.id, r);
        return rows;
      }

      // 1. remembered choices
      const remembered = distinct.filter((v) => memory.has(lower(v)));
      if (remembered.length) {
        const ids = remembered.map((v) => memory.get(lower(v)));
        const found = new Set((await searchRead([["id", "in", ids]])).map((r) => r.id));
        for (const v of remembered) if (found.has(memory.get(lower(v)))) add(v, memory.get(lower(v)), "memory");
      }

      // 2. database ids and external ids
      if (mode === "dbid") {
        const ids = distinct.filter((v) => /^\d+$/.test(v)).map(Number);
        const found = new Set(ids.length ? (await searchRead([["id", "in", ids]])).map((r) => r.id) : []);
        for (const v of distinct) if (found.has(Number(v))) add(v, Number(v), "id");
      } else {
        const xmlids = distinct.filter((v) => XMLID.test(v) && !/\s/.test(v));
        for (const part of chunks(xmlids)) {
          // model = relation AND (m1.n1 OR m2.n2 OR ...), each pair being "&", module, name.
          const domain = [
            ["model", "=", relation],
            ...Array(part.length - 1).fill("|"),
            ...part.flatMap((v) => {
              const i = v.indexOf(".");
              return ["&", ["module", "=", v.slice(0, i)], ["name", "=", v.slice(i + 1)]];
            }),
          ];
          const rows = await client.call("ir.model.data", "search_read", [domain, ["module", "name", "res_id"]]);
          const byXmlid = new Map(rows.map((r) => [`${r.module}.${r.name}`, r.res_id]));
          for (const v of part) if (byXmlid.has(v)) add(v, byXmlid.get(v), "xmlid");
        }
        const xmlIds = [...exact.values()].flatMap((m) => [...m.keys()]).filter((id) => !records.has(id));
        if (xmlIds.length) await searchRead([["id", "in", xmlIds]]);
      }

      if (mode !== "name") return finish();

      // 3. exact name, case-insensitive
      const pending = distinct.filter((v) => !exact.get(v).size);
      const matchName = (v, r) => {
        const l = lower(lookup.get(v));
        return lower(r.display_name) === l || (r.name && typeof r.name === "string" && lower(r.name) === l);
      };
      for (const part of chunks(pending)) {
        const terms = part.map((v) => lookup.get(v));
        const leaves = terms.map((t) => ["display_name", "=ilike", escapeLike(t)]);
        if (has("name") && ["char", "text"].includes(schema.fields.get("name").type)) leaves.push(["name", "in", terms]);
        let rows;
        try {
          rows = await searchRead(orDomain(leaves));
        } catch {
          // display_name isn't searchable before Odoo 17: fall back to name_search per value.
          rows = [];
          await pool(part, 6, async (v) => {
            check();
            const found = await client.call(relation, "name_search", [lookup.get(v), [], "=", 10]).catch(() => []);
            for (const [id] of found) add(v, id, "name");
          }, signal);
          const ids = part.flatMap((v) => [...exact.get(v).keys()]).filter((id) => !records.has(id));
          if (ids.length) await searchRead([["id", "in", ids]]);
        }
        for (const v of part) {
          for (const r of rows) if (matchName(v, r)) add(v, r.id, "name");
          // A display_name match through another searchable field (e.g. a partner's email).
          if (!exact.get(v).size) {
            for (const r of rows) {
              if (keys.some((k) => lower(r[k]) === lower(v))) add(v, r.id, "name");
            }
          }
        }
        if (onProgress) onProgress();
        check();
      }

      // 4. alternate keys
      for (const key of keys) {
        const left = distinct.filter((v) => !exact.get(v).size);
        for (const part of chunks(left)) {
          check();
          const variants = [...new Set(part.flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()]))];
          const rows = await searchRead([[key, "in", variants]]);
          for (const v of part) for (const r of rows) if (lower(r[key]) === lower(v)) add(v, r.id, `key:${key}`);
        }
      }

      // 5. fuzzy matches for what is still unmatched: small comodels (countries, tags, units...)
      // are ranked locally against every record; big ones go through name_search.
      const fuzzy = new Map();
      const unmatched = distinct.filter((v) => !exact.get(v).size).slice(0, FUZZY_MAX);
      const everything = unmatched.length ? await allNames(relation) : null;
      if (everything) {
        for (const v of unmatched) fuzzy.set(v, NS.text.rank(lookup.get(v), everything).map((c) => ({ id: c.id, label: c.label, score: c.score })));
      } else {
        await pool(unmatched, 6, async (v) => {
          check();
          const term = lookup.get(v);
          const ids = new Map();
          const run = async (q) => {
            const found = await client.call(relation, "name_search", [q, [], "ilike", 8]).catch(() => []);
            for (const [id, label] of found) ids.set(id, label);
          };
          await run(term);
          const longest = NS.text.tokens(term).sort((a, b) => b.length - a.length)[0];
          if (ids.size < 3 && longest && longest.length >= 4 && longest !== norm(term)) await run(longest);
          if (ids.size < 3 && longest && longest.length >= 5) await run(longest.slice(0, 4));
          fuzzy.set(v, [...ids].map(([id, label]) => ({ id, label, score: similarity(term, label) })));
          if (onProgress) onProgress();
        }, signal);
      }
      const fuzzyIds = [...fuzzy.values()].flat().map((c) => c.id).filter((id) => !records.has(id));
      for (const part of chunks([...new Set(fuzzyIds)], 500)) await searchRead([["id", "in", part]]);

      check();
      return finish(fuzzy);

      function candidate(id, score) {
        const r = records.get(id) || { id, display_name: `#${id}` };
        const links = {};
        for (const f of [...linkFields, "company_id"]) if (Array.isArray(r[f])) links[f] = r[f][0];
        const detail = [
          ...keys.filter((k) => r[k] && lower(r[k]) !== lower(r.display_name)).map((k) => r[k]),
          Array.isArray(r.company_id) ? r.company_id[1] : null,
          r.active === false ? "archived" : null,
        ].filter(Boolean).join(" · ");
        return { id, label: r.display_name, score, active: r.active !== false, links, detail };
      }

      function finish(fuzzyMap = new Map()) {
        const out = new Map();
        for (const v of distinct) {
          const ex = exact.get(v);
          if (ex.size) {
            const cands = [...ex.keys()].map((id) => candidate(id, 1));
            const active = cands.filter((c) => c.active);
            const source = [...ex.values()][0];
            if (cands.length === 1) out.set(v, { status: cands[0].active ? "ok" : "archived", id: cands[0].id, source, candidates: cands });
            else if (active.length === 1) out.set(v, { status: "ok", id: active[0].id, source, candidates: cands });
            else out.set(v, { status: "ambiguous", id: null, source, candidates: active.length ? active : cands });
            continue;
          }
          const fz = (fuzzyMap.get(v) || []).map((c) => ({ ...candidate(c.id, c.score), score: c.score }));
          fz.sort((a, b) => b.score - a.score);
          const [best, second] = fz;
          if (best && best.score >= PROBABLE && (!second || second.score < best.score - 0.08)) {
            out.set(v, { status: "probable", id: best.id, source: "fuzzy", candidates: fz.filter((c) => c.score >= 0.35).slice(0, 5) });
          } else {
            out.set(v, { status: "missing", id: null, source: "", candidates: fz.filter((c) => c.score >= 0.35).slice(0, 5) });
          }
        }
        return out;
      }
    }

    return { resolve };
  }

  NS.m2o = { createResolver, escapeLike, orDomain };
})();
