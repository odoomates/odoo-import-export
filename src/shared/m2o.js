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

  function makeCandidate(records, id, score, linkFields, keys) {
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

  // No exact match: one close candidate that stands out is probable, otherwise missing.
  function fromFuzzy(fz) {
    fz.sort((a, b) => b.score - a.score);
    const [best, second] = fz;
    const candidates = fz.filter((c) => c.score >= 0.35).slice(0, 5);
    if (best && best.score >= PROBABLE && (!second || second.score < best.score - 0.08)) {
      return { status: "probable", id: best.id, source: "fuzzy", candidates };
    }
    return { status: "missing", id: null, source: "", candidates };
  }

  // Exact matches: one record (or one active among archived ones) is ok, several are ambiguous.
  function fromExact(cands, source) {
    const active = cands.filter((c) => c.active);
    if (cands.length === 1) return { status: cands[0].active ? "ok" : "archived", id: cands[0].id, source, candidates: cands };
    if (active.length === 1) return { status: "ok", id: active[0].id, source, candidates: cands };
    return { status: "ambiguous", id: null, source, candidates: active.length ? active : cands };
  }

  /* Product columns: when values aren't found, the user says how they are written and they
   * are searched that way only (resolveAs). Code formats look the code up, then compare the
   * name part with the product found: a different name makes it a close match to confirm. */
  const PRODUCT_MODELS = new Set(["product.product", "product.template"]);
  const isProduct = (relation) => PRODUCT_MODELS.has(relation);
  const PRODUCT_FORMATS = [
    { id: "name", label: "Name" },
    { id: "code", label: "Internal reference (code)" },
    { id: "barcode", label: "Barcode" },
    { id: "bracket", label: "[Code] Name", re: /^\[\s*(?<code>[^\]]+?)\s*\]\s*(?<name>.*)$/ },
    { id: "dash", label: "Code - Name", re: /^(?<code>\S+?)\s*[-–—|:]\s+(?<name>.+)$/ },
    { id: "paren", label: "Name (Code)", re: /^(?<name>.+?)\s*[([]\s*(?<code>[^)\]]+?)\s*[)\]]$/ },
    { id: "space", label: "Code Name (first word is the code)", re: /^(?<code>\S+)\s+(?<name>.+)$/ },
    { id: "xmlid", label: "External ID" },
  ];
  const NAME_MATCH = 0.6; // name part vs the name of the product its code found

  // Spreadsheet damage on codes: "1001.0" -> "1001", "8.71234E+12" -> "8712340000000".
  function cleanCode(v) {
    const s = String(v ?? "").trim();
    if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, "");
    if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n) && n < 1e21) return BigInt(Math.round(n)).toString();
    }
    return s;
  }

  // A barcode that lost its leading zeros: also try it padded to the EAN/UPC lengths.
  function barcodeVariants(code) {
    const out = [code];
    if (/^\d+$/.test(code)) for (const n of [8, 12, 13, 14]) if (n > code.length) out.push(code.padStart(n, "0"));
    return out;
  }

  /* What to search for a value written in `format`: {code, name} | {name} | {xmlid}, or null
   * when the value doesn't fit the format. */
  function splitValue(format, value) {
    const v = String(value ?? "").trim();
    if (!v) return null;
    if (format === "name") return { name: v };
    if (format === "code" || format === "barcode") return { code: cleanCode(v) };
    if (format === "xmlid") return XMLID.test(v) && !/\s/.test(v) ? { xmlid: v } : null;
    const f = PRODUCT_FORMATS.find((x) => x.id === format);
    const m = f && f.re && f.re.exec(v);
    if (!m) return null;
    const code = cleanCode(m.groups.code);
    return code ? { code, name: m.groups.name.trim() } : null;
  }

  // The format most of the values fit (a suggestion: nothing is searched until the user asks).
  function guessFormat(values) {
    const score = new Map(PRODUCT_FORMATS.map((f) => [f.id, 0]));
    for (const raw of values) {
      const v = String(raw ?? "").trim();
      if (!v) continue;
      const id = splitValue("xmlid", v) ? "xmlid"
        : ["bracket", "paren", "dash"].find((f) => splitValue(f, v))
          || (/^\d{8,14}$/.test(cleanCode(v)) ? "barcode" : !/\s/.test(v) && /\d/.test(v) ? "code" : /\s/.test(v) && /\d/.test(v.split(/\s/)[0]) ? "space" : "name");
      score.set(id, score.get(id) + 1);
    }
    return [...score].reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
  }

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
        // Products: an External ID of the other product model (a template's in a variant
        // column: its variant, or its variants to pick from; a variant's: its template).
        const across = isProduct(relation) ? xmlids.filter((v) => !exact.get(v).size) : [];
        if (across.length) {
          const res = await resolveAs({ relation, values: across, format: "xmlid", signal });
          for (const v of across) {
            const r = res.get(v);
            if (r && r.status !== "missing") for (const c of r.candidates) add(v, c.id, "xmlid");
          }
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
        // "[FURN_0002] Desk Pad": Odoo looks the bracketed code up as written, so the escaped
        // "=ilike" term ("FURN\_0002") misses it; "in" passes the code unescaped.
        if (isProduct(relation)) leaves.push(["display_name", "in", terms]);
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
        return makeCandidate(records, id, score, linkFields, keys);
      }

      function finish(fuzzyMap = new Map()) {
        const out = new Map();
        for (const v of distinct) {
          const ex = exact.get(v);
          if (ex.size) {
            out.set(v, fromExact([...ex.keys()].map((id) => candidate(id, 1)), [...ex.values()][0]));
            continue;
          }
          out.set(v, fromFuzzy((fuzzyMap.get(v) || []).map((c) => ({ ...candidate(c.id, c.score), score: c.score }))));
        }
        return out;
      }
    }

    /* Product values searched in the format the user picked (PRODUCT_FORMATS id). Codes and
     * barcodes are looked up on the variants, so a template column also finds the templates
     * of several variants; an External ID of the other product model is followed across.
     * Returns Map raw -> result, like resolve(); a result may carry a `note`. */
    async function resolveAs({ relation, values, format, linkFields = [], signal }) {
      const check = () => NS.rpc.throwIfAborted(signal);
      const P = "product.product";
      const T = "product.template";
      const tmpl = relation === T;
      const schema = await schemas.load(relation);
      const keys = ["default_code", "barcode"].filter((f) => schema.fields.has(f));
      const readFields = [...new Set(["display_name", ...["name", "active", "company_id", ...keys, ...linkFields].filter((f) => schema.fields.has(f))])];
      const distinct = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
      const parts = new Map(distinct.map((v) => [v, splitValue(format, v)]));
      const found = new Map(distinct.map((v) => [v, new Set()]));
      const fuzzy = new Map();
      const records = new Map();
      const source = `format:${format}`;

      async function read(ids) {
        for (const part of chunks([...new Set(ids)].filter((id) => !records.has(id)), 500)) {
          for (const r of await client.call(relation, "read", [part, readFields], {}, ALL)) records.set(r.id, r);
        }
      }
      // Variants whose `field` is one of the terms of a value -> the value's target ids.
      async function byVariantKey(field, termsOf) {
        const left = distinct.filter((v) => !found.get(v).size && termsOf(v).length);
        for (const part of chunks(left)) {
          check();
          const terms = [...new Set(part.flatMap((v) => termsOf(v)))];
          const rows = await client.call(P, "search_read", [[[field, "in", terms]], [field, "product_tmpl_id"]], { limit: 2000 }, ALL);
          for (const v of part) {
            const wanted = new Set(termsOf(v).map(lower));
            for (const r of rows) if (r[field] && wanted.has(lower(r[field]))) found.get(v).add(tmpl ? r.product_tmpl_id[0] : r.id);
          }
        }
      }
      async function fuzzyName(v, term) {
        const ids = new Map();
        for (const [id, label] of await client.call(relation, "name_search", [term, [], "ilike", 8]).catch(() => [])) ids.set(id, label);
        fuzzy.set(v, [...ids].map(([id, label]) => ({ id, label, term })));
      }

      if (format === "xmlid") {
        const xmlids = distinct.filter((v) => parts.get(v));
        for (const part of chunks(xmlids)) {
          check();
          const domain = [
            ["model", "in", [P, T]],
            ...Array(part.length - 1).fill("|"),
            ...part.flatMap((v) => {
              const i = v.indexOf(".");
              return ["&", ["module", "=", v.slice(0, i)], ["name", "=", v.slice(i + 1)]];
            }),
          ];
          const rows = await client.call("ir.model.data", "search_read", [domain, ["module", "name", "model", "res_id"]]);
          const other = rows.filter((r) => r.model !== relation).map((r) => r.res_id);
          // The other model's records, mapped to ours: a variant's template, a template's variants.
          const across = new Map();
          if (other.length) {
            const linked = tmpl
              ? await client.call(P, "read", [other, ["product_tmpl_id"]], {}, ALL)
              : await client.call(P, "search_read", [[["product_tmpl_id", "in", other]], ["product_tmpl_id"]], {}, ALL);
            for (const r of linked) {
              const from = tmpl ? r.id : r.product_tmpl_id[0];
              if (!across.has(from)) across.set(from, []);
              across.get(from).push(tmpl ? r.product_tmpl_id[0] : r.id);
            }
          }
          for (const r of rows) {
            const v = `${r.module}.${r.name}`;
            if (!found.has(v)) continue;
            for (const id of r.model === relation ? [r.res_id] : across.get(r.res_id) || []) found.get(v).add(id);
          }
        }
      } else if (format === "name") {
        for (const part of chunks(distinct)) {
          check();
          const rows = await client.call(relation, "search_read", [orDomain(part.map((v) => ["name", "=ilike", escapeLike(v)])), ["name"]], { limit: 2000 }, ALL);
          for (const v of part) for (const r of rows) if (lower(r.name) === lower(v)) found.get(v).add(r.id);
        }
        await pool(distinct.filter((v) => !found.get(v).size).slice(0, FUZZY_MAX), 6, (v) => (check(), fuzzyName(v, v)), signal);
      } else {
        const code = (v) => (parts.get(v) ? [parts.get(v).code] : []);
        const cased = (v) => code(v).flatMap((c) => [c, c.toLowerCase(), c.toUpperCase()]);
        const padded = (v) => code(v).flatMap(barcodeVariants);
        if (format === "barcode") await byVariantKey("barcode", padded);
        else {
          await byVariantKey("default_code", cased);
          // A code that is in fact a barcode.
          if (format !== "code") await byVariantKey("barcode", padded);
        }
        // Code not found: the name part (if any) may still be close to a product.
        const left = distinct.filter((v) => !found.get(v).size && parts.get(v) && parts.get(v).name).slice(0, FUZZY_MAX);
        await pool(left, 6, (v) => (check(), fuzzyName(v, parts.get(v).name)), signal);
      }
      check();
      await read([...found.values()].flatMap((s) => [...s]).concat([...fuzzy.values()].flat().map((c) => c.id)));

      const out = new Map();
      for (const v of distinct) {
        const ids = [...found.get(v)];
        if (!ids.length) {
          // Scored on the product name too: name_search labels carry the code ("[A1] Desk").
          out.set(v, fromFuzzy((fuzzy.get(v) || []).map((c) => {
            const r = records.get(c.id);
            const score = Math.max(similarity(c.term, c.label), r && r.name ? similarity(c.term, r.name) : 0);
            return makeCandidate(records, c.id, score, linkFields, keys);
          })));
          continue;
        }
        const res = fromExact(ids.map((id) => makeCandidate(records, id, 1, linkFields, keys)), source);
        const name = parts.get(v) && parts.get(v).code ? parts.get(v).name : "";
        const r = res.id && records.get(res.id);
        if (name && r) {
          // The code found a product with another name: a close match to confirm, not a match.
          const score = similarity(name, r.name || r.display_name);
          if (score < NAME_MATCH) {
            out.set(v, { ...res, status: "probable", source, candidates: res.candidates.map((c) => ({ ...c, score })),
              note: `code ${parts.get(v).code} is “${r.display_name}”, not “${name}”` });
            continue;
          }
        }
        out.set(v, res);
      }
      return out;
    }

    return { resolve, resolveAs };
  }

  NS.m2o = { createResolver, escapeLike, orDomain, isProduct, PRODUCT_FORMATS, splitValue, guessFormat, cleanCode, barcodeVariants };
})();
